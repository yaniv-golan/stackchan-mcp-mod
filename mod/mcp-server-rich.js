/*
 * MCP server for Stack-chan MODs (Streamable HTTP, JSON responses only).
 *
 * Derived from stack-chan/stack-chan firmware/host/modules/connectivity/mcp-server/mcp-server.ts (v1.1.0),
 * Apache License 2.0. Changes from the original:
 * - tool handlers may return a string or a full MCP result ({ content: [...], isError? }), so tools can return images
 * - tools may declare a JSON Schema `inputSchema` directly (enums, ranges) instead of the flat `parameters` list
 * - a throwing handler becomes an `isError` tool result instead of a JSON-RPC "Parse error"
 * - notifications get HTTP 202 with no body, `ping` is supported, unknown tools return JSON-RPC -32602
 * - the MCP-Protocol-Version header is validated, answering 400 for a version this server does not implement
 * - parse and envelope errors answer with HTTP 400, so a client with no usable id fails fast
 * - connection-level hardening the unauthenticated path needs: body size cap, no chunked encoding, a
 *   receive timeout, a concurrent-connection cap, and draining bodies nobody reads so an aborted
 *   upload cannot leave an unhandled rejection (which reboots this device)
 * - a minimum token length, a 503 rather than a silent close at the connection cap, and a listener that
 *   restarts itself indefinitely if the accept loop ever ends
 */
import { base64Length, writeBase64 } from 'base64'
import { DOMAIN } from 'consts'
import Headers from 'headers'
import listen, { Response } from 'listen'
import { authorizeMCPRequest, normalizeMCPToken } from 'mcp-auth'
import Preference from 'preference'
import Timer from 'timer'

// The single-POST transport with a 405 on GET is the Streamable HTTP shape, introduced in 2025-03-26;
// declaring 2024-11-05 (as the upstream server does) names a revision that has no such transport.
const PROTOCOL_VERSION = '2025-06-18'
// Versions whose Streamable HTTP shape this server implements. The spec requires answering 400 to an
// MCP-Protocol-Version header naming anything else, rather than silently carrying on.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
// Stands in for the base64 payload while the small JSON envelope is built as a string.
const BINARY_PLACEHOLDER = '@@stackchan-base64@@'
// The accept loop is restarted for as long as the MOD runs. There was a cap of five attempts two seconds
// apart - eight seconds of budget - so a listener that died while nobody was looking was gone for good, and
// the robot sat on the network, pingable, with nothing bound to its port until somebody pressed reset. That
// was the only unrecoverable software state this MOD had.
const LISTENER_RESTART_DELAY_MIN_MS = 2000
const LISTENER_RESTART_DELAY_MAX_MS = 60000
// The HTTP layer buffers a request body into RAM before any of this code runs, and before the token is
// checked. Without a cap, an unauthenticated request large enough to exhaust memory reboots the device -
// and a reboot on this hardware leaves the display dead until someone power-cycles it by hand. The
// largest legitimate request is a tools/call carrying a sentence of speech, so 8 KB is generous.
const MAX_REQUEST_BYTES = 8192
// A connection that never finishes its request would otherwise hold a slot forever.
const REQUEST_TIMEOUT_MS = 10000
const MAX_CONCURRENT_CONNECTIONS = 4
// Anything shorter is not worth defending; a short token plus an open LAN port is an invitation.
const MIN_TOKEN_LENGTH = 32

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function schemaFromParameters(parameters = []) {
  const properties = {}
  const required = []
  for (const param of parameters) {
    properties[param.name] = { type: param.type, description: param.description }
    if (param.required) required.push(param.name)
  }
  return { type: 'object', properties, required }
}

function normalizeResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) return result
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] }
}

export class MCPServer {
  #tools = new Map()
  #port
  #token
  #status = 'starting'
  #error
  #name
  #version
  #tokenTooShort = false
  #connections = 0
  #restarts = 0

  constructor(config = {}) {
    this.#port = config.port ?? 8080
    this.#name = config.name ?? 'stackchan-mcp-mod'
    this.#version = config.version ?? '0.0.0'
    const token = normalizeMCPToken(config.token) ?? normalizeMCPToken(Preference.get(DOMAIN.mcp, 'token'))
    if (token && token.length < MIN_TOKEN_LENGTH) {
      trace(
        `[mcp] mcp.token is only ${token.length} characters; refusing to serve with a token shorter than ${MIN_TOKEN_LENGTH}\n`,
      )
      this.#token = undefined
      this.#tokenTooShort = true
    } else {
      this.#token = token
    }
    for (const tool of config.tools ?? []) this.addTool(tool)
    if (!this.#token && !this.#tokenTooShort) {
      trace('[mcp] mcp.token is not configured; POST /mcp requests will be rejected\n')
    }
    this.#startServer().catch((error) => trace(`[mcp] server loop ended: ${errorMessage(error)}\n`))
  }

  addTool(tool) {
    this.#tools.set(tool.name, tool)
  }

  get tools() {
    return Array.from(this.#tools.values())
  }

  get status() {
    return this.#status
  }

  get error() {
    return this.#error
  }

  /**
   * How many times the accept loop has had to be restarted. Non-zero means the server has been dying and
   * recovering, which nothing else surfaces while it is still answering.
   */
  get restarts() {
    return this.#restarts
  }

  /**
   * Serves connections, and restarts the listener if the accept loop ever ends.
   * A response the device cannot finish sending (a large image) kills the loop, and without this the
   * robot stays on the network with no MCP server until someone power-cycles it.
   */
  async #startServer() {
    let delay = LISTENER_RESTART_DELAY_MIN_MS
    for (;;) {
      trace(`[mcp] starting on port ${this.#port}${this.#restarts > 0 ? ` (restart ${this.#restarts})` : ''}\n`)
      // A handler whose respondWith never settles never reaches its finally, so its slot is never given
      // back, and the field outlives the accept loop. Reset here to recover those - the decrement is
      // clamped at zero, so handlers still in flight from the dead loop cannot drive this negative and
      // silently raise the connection cap in the one state where the device is already unhealthy.
      this.#connections = 0
      let served = false
      try {
        this.#status = 'running'
        for await (const connection of listen({ port: this.#port })) {
          served = true
          this.#handleConnection(connection).catch((error) => trace(`[mcp] connection error: ${errorMessage(error)}\n`))
        }
        this.#error = 'listener closed'
      } catch (error) {
        this.#error = errorMessage(error)
      }
      this.#status = 'failed'
      this.#restarts += 1
      trace(`[mcp] listener stopped: ${this.#error}\n`)
      // A loop that accepted at least one connection was working, so start the backoff over. One that died
      // without accepting anything is usually a port not yet released, and hammering it does not help.
      if (served) delay = LISTENER_RESTART_DELAY_MIN_MS
      trace(`[mcp] restarting the listener in ${delay} ms\n`)
      await this.#sleep(delay)
      delay = Math.min(delay * 2, LISTENER_RESTART_DELAY_MAX_MS)
    }
  }

  /**
   * A delay that cannot reject. Timer.set throwing would otherwise escape this loop as an unhandled
   * rejection - which on this device is a reboot - and leave the listener unrecoverable again, which is the
   * whole failure this method exists to prevent.
   */
  #sleep(ms) {
    return new Promise((resolve) => {
      try {
        Timer.set(resolve, ms)
      } catch (error) {
        trace(`[mcp] Timer.set failed: ${errorMessage(error)}\n`)
        resolve()
      }
    })
  }

  /** Reads a header. The HTTP layer lowercases names at parse time, so lowercase keys are correct. */
  #header(request, name) {
    return request.headers?.get(name) ?? undefined
  }

  /**
   * Consumes a body nobody is going to read, with the rejection handled.
   * A client that sends headers and then drops the socket rejects the body promise; if nothing is
   * awaiting it, the rejection is unhandled, and an unhandled rejection aborts XS and reboots the robot.
   */
  #drainBody(request) {
    try {
      const body = request.arrayBuffer?.()
      if (body && typeof body.then === 'function') body.then(undefined, () => undefined)
    } catch (error) {
      trace(`[mcp] drain failed: ${errorMessage(error)}\n`)
    }
  }

  /** Rejects a request before its body matters. Returns a reason to close on, or undefined to proceed. */
  #refuseEarly(request) {
    const encoding = this.#header(request, 'transfer-encoding')
    if (encoding) return `transfer-encoding ${encoding} is not accepted`
    const header = this.#header(request, 'content-length')
    if (header !== undefined) {
      const declared = Number(header)
      // Fail closed: a Content-Length that will not parse is refused rather than assumed small.
      if (!Number.isFinite(declared) || declared < 0) return `unparseable content-length "${header}"`
      if (declared > MAX_REQUEST_BYTES) {
        return `request of ${declared} bytes exceeds the ${MAX_REQUEST_BYTES} byte limit`
      }
    }
    return undefined
  }

  async #handleConnection(connection) {
    if (this.#connections >= MAX_CONCURRENT_CONNECTIONS) {
      // Closing silently gave the client an empty reply, which carries no information and is
      // indistinguishable from a crashed server. Answer instead - but drain the body first: a rejected
      // body promise nobody awaits is an unhandled rejection, and that reboots this device.
      trace('[mcp] too many connections; refusing\n')
      try {
        this.#drainBody(connection.request)
        const body = { error: 'Service Unavailable', reason: 'too many concurrent connections' }
        await connection.respondWith(this.#json(503, body, { 'Retry-After': '1' }))
      } catch (error) {
        trace(`[mcp] refusal response failed: ${errorMessage(error)}\n`)
        try {
          connection.close()
        } catch (closeError) {
          trace(`[mcp] refusal close failed: ${errorMessage(closeError)}\n`)
        }
      }
      return
    }
    this.#connections += 1

    // Close a connection that never delivers its request, so a stalled client cannot hold a slot.
    let timer = Timer.set(() => {
      timer = undefined
      trace('[mcp] request timed out; closing\n')
      try {
        connection.close()
      } catch (error) {
        trace(`[mcp] timeout close failed: ${errorMessage(error)}\n`)
      }
    }, REQUEST_TIMEOUT_MS)
    const clearTimer = () => {
      if (timer === undefined) return
      Timer.clear(timer)
      timer = undefined
    }

    try {
      const request = connection.request
      const method = request.method?.toUpperCase()
      const pathname = request.url?.pathname

      const refusal = this.#refuseEarly(request)
      if (refusal) {
        trace(`[mcp] refusing connection: ${refusal}\n`)
        connection.close()
        return
      }

      let response
      if (method === 'POST' && pathname === '/mcp') {
        const contentType = this.#header(request, 'content-type')
        const authorization = this.#header(request, 'authorization')
        // The MCP spec requires refusing a cross-origin request outright: an Origin header means a
        // browser sent it, and no legitimate MCP client is a browser page. This is what actually stops
        // DNS rebinding, and it does not depend on the content-type heuristic below.
        const origin = this.#header(request, 'origin')
        if (origin) {
          this.#drainBody(request)
          await connection.respondWith(this.#json(403, { error: 'Forbidden' }))
          return
        }
        const clientVersion = this.#header(request, 'mcp-protocol-version')
        if (clientVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(String(clientVersion))) {
          this.#drainBody(request)
          await connection.respondWith(
            this.#json(400, {
              error: 'Unsupported MCP-Protocol-Version',
              supported: SUPPORTED_PROTOCOL_VERSIONS,
            }),
          )
          return
        }
        const auth = authorizeMCPRequest(authorization, this.#token)
        if (!auth.authorized) {
          this.#drainBody(request)
          response = this.#json(401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
        } else if (contentType && !String(contentType).toLowerCase().includes('application/json')) {
          // A browser cannot set application/json cross-origin without a preflight this server fails.
          this.#drainBody(request)
          response = this.#json(415, { error: 'Unsupported Media Type' })
        } else {
          // Read the body while the receive timeout still applies, then stop the clock before
          // dispatching: a tool may legitimately run far longer than any request should take to arrive.
          const body = await request.text()
          clearTimer()
          response = await this.#handleMCPMessage(body)
        }
      } else if (method === 'GET' && pathname === '/health') {
        this.#drainBody(request)
        response = this.#json(200, { status: 'ok' })
      } else if (pathname === '/mcp') {
        // No server-initiated SSE stream; Streamable HTTP clients accept 405 here.
        this.#drainBody(request)
        response = this.#json(405, { error: 'Method Not Allowed' }, { Allow: 'POST' })
      } else {
        this.#drainBody(request)
        response = this.#json(404, { error: 'Not Found' })
      }

      await connection.respondWith(response)
    } catch (error) {
      trace(`[mcp] request error: ${errorMessage(error)}\n`)
      try {
        await connection.respondWith(this.#json(500, { error: 'Internal Server Error' }))
      } catch (respondError) {
        trace(`[mcp] error response failed: ${errorMessage(respondError)}\n`)
      }
    } finally {
      clearTimer()
      this.#connections = Math.max(0, this.#connections - 1)
    }
  }

  async #handleMCPMessage(body) {
    let message
    try {
      message = JSON.parse(body ?? '')
    } catch (error) {
      trace(`[mcp] parse error: ${errorMessage(error)}\n`)
      return this.#rpcError(null, -32700, 'Parse error', 400)
    }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return this.#rpcError(message?.id ?? null, -32600, 'Invalid Request', 400)
    }
    // Notifications (no id) get no JSON-RPC response.
    if (message.id === undefined) return new Response(new ArrayBuffer(0), { status: 202 })

    const id = message.id
    try {
      switch (message.method) {
        case 'initialize':
          return this.#rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: this.#name, version: this.#version },
          })
        case 'ping':
          return this.#rpcResult(id, {})
        case 'tools/list':
          return this.#rpcResult(id, {
            tools: this.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema ?? schemaFromParameters(tool.parameters),
            })),
          })
        case 'tools/call':
          return await this.#handleToolsCall(id, message.params)
        default:
          return this.#rpcError(id, -32601, 'Method not found')
      }
    } catch (error) {
      trace(`[mcp] ${message.method} failed: ${errorMessage(error)}\n`)
      return this.#rpcError(id, -32603, `Internal error: ${errorMessage(error)}`)
    }
  }

  async #handleToolsCall(id, params) {
    const name = params?.name
    const tool = typeof name === 'string' ? this.#tools.get(name) : undefined
    if (!tool) return this.#rpcError(id, -32602, `Unknown tool: ${name}`)
    let result
    try {
      result = normalizeResult(await tool.handler(params.arguments ?? {}))
    } catch (error) {
      trace(`[mcp] tool ${name} threw: ${errorMessage(error)}\n`)
      result = { content: [{ type: 'text', text: `Error: ${errorMessage(error)}` }], isError: true }
    }
    return this.#rpcResult(id, result)
  }

  #json(status, data, extraHeaders) {
    const headers = new Headers()
    headers.set('Content-Type', 'application/json')
    if (extraHeaders) {
      for (const name of Object.keys(extraHeaders)) headers.set(name, extraHeaders[name])
    }
    return new Response(ArrayBuffer.fromString(JSON.stringify(data)), { status, headers })
  }

  /**
   * Serializes a response whose single large field is a byte array (an image or a file), encoding it as
   * base64 straight into the response buffer so the payload is never also alive as a JS string.
   * `holder` is the object carrying the bytes; `field` is the JSON key the base64 belongs under.
   */
  #jsonWithBinary(data, holder, sourceField, field) {
    const bytes = holder[sourceField]
    holder[field] = BINARY_PLACEHOLDER
    delete holder[sourceField]
    const envelope = JSON.stringify(data)
    const split = envelope.indexOf(BINARY_PLACEHOLDER)
    // `id` is client-controlled and serialized first, so a client can put the placeholder there and
    // displace the split. One occurrence means ours; otherwise fall back to encoding the payload as a
    // JS string, which costs an extra copy of it but still returns the right bytes.
    if (split < 0 || envelope.indexOf(BINARY_PLACEHOLDER, split + 1) >= 0) {
      trace('[mcp] binary placeholder collision; using the slow encoding path\n')
      holder[field] = bytes.toBase64()
      return this.#json(200, data)
    }
    const prefix = ArrayBuffer.fromString(envelope.slice(0, split))
    const suffix = ArrayBuffer.fromString(envelope.slice(split + BINARY_PLACEHOLDER.length))
    const out = new Uint8Array(prefix.byteLength + base64Length(bytes.length) + suffix.byteLength)
    out.set(new Uint8Array(prefix), 0)
    const end = writeBase64(out, prefix.byteLength, bytes)
    out.set(new Uint8Array(suffix), end)
    const headers = new Headers()
    headers.set('Content-Type', 'application/json')
    return new Response(out.buffer, { status: 200, headers })
  }

  #rpcResult(id, result) {
    const response = { jsonrpc: '2.0', id, result }
    const content = result?.content
    if (Array.isArray(content)) {
      // An image carries raw bytes as `dataBytes` -> `data`; a file resource as `blobBytes` -> `blob`.
      // Only one block can take the streaming path, so any others are encoded the ordinary way rather
      // than left as byte arrays, which would serialize as an object and blow the response size.
      const binary = []
      for (const item of content) {
        if (item?.dataBytes) binary.push([item, 'dataBytes', 'data'])
        else if (item?.resource?.blobBytes) binary.push([item.resource, 'blobBytes', 'blob'])
      }
      for (let i = 1; i < binary.length; i += 1) {
        const [holder, source, field] = binary[i]
        holder[field] = holder[source].toBase64()
        delete holder[source]
      }
      if (binary.length > 0) {
        const [holder, source, field] = binary[0]
        return this.#jsonWithBinary(response, holder, source, field)
      }
    }
    return this.#json(200, response)
  }

  #rpcError(id, code, message, status = 200) {
    // A parse or envelope error has no usable id, so a client cannot match it to a pending request;
    // an HTTP error status lets it fail fast instead of waiting for its own timeout.
    return this.#json(status, { jsonrpc: '2.0', id, error: { code, message } })
  }
}

export default MCPServer
