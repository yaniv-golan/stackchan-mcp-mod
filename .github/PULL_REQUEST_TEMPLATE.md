## What this changes

## Tested on the device

<!-- Which robot and firmware, what you ran, what happened. "It builds" is not enough: this project's
     bugs are almost all hardware behaviour. If you could not test on hardware, say so plainly. -->

## Checklist

- [ ] `scripts/check.sh` passes
- [ ] Handlers cannot throw (an uncaught exception reboots the device)
- [ ] Numeric inputs are clamped before reaching hardware
- [ ] Any large response is size-checked before being produced
- [ ] `CHANGELOG.md` updated under `Unreleased`
- [ ] New hardware findings recorded in `docs/device-notes.md`
