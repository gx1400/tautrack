# Changelog

## [0.3.0](https://github.com/gx1400/tautrack/compare/v0.2.1...v0.3.0) (2026-11-15)


### Features

* notify when a newer release is published ([7aeaec8](https://github.com/gx1400/tautrack/commit/7aeaec85b15c9266fe2196c34311ea5321b26247))

## [0.2.1](https://github.com/gx1400/tautrack/compare/v0.2.0...v0.2.1) (2026-11-15)


### Bug Fixes

* point image and project URLs at the renamed repository ([851b8bd](https://github.com/gx1400/tautrack/commit/851b8bdc95b44352d04cea495661d11b6d3799cd))


### Documentation

* add a sigma(tau) mark and dashboard screenshots ([4a24f4c](https://github.com/gx1400/tautrack/commit/4a24f4cbe8c780878ea2bf754da85dd61bbc2d5e))
* state that only one unit has ever been tested ([12c9e54](https://github.com/gx1400/tautrack/commit/12c9e546ed478e1ce186cca44e6a5731b6a77cbb))


### Build System

* **deps:** bump python from 3.12-slim to 3.15-slim ([732d555](https://github.com/gx1400/tautrack/commit/732d5553474881669dc15dc0872eb0403f8dffdb))
* **deps:** bump python from 3.12-slim to 3.15-slim ([931c214](https://github.com/gx1400/tautrack/commit/931c2140be30115b5f067966f6b781e26b2d4c8b))

## [0.2.0](https://github.com/gx1400/tautracker/compare/v0.1.0...v0.2.0) (2026-11-15)


### Features

* add storage, poller, web UI, CI and container packaging ([6433caf](https://github.com/gx1400/tautracker/commit/6433cafe66e8810a18cb1a34c718680dc543797c))
* **tools:** add a ser2net work-alike, replacing the ad-hoc dev bridge ([f14d25f](https://github.com/gx1400/tautracker/commit/f14d25f50feb899c5b01c1093d4cae0903f8ebe0))
* **web:** chart signal strength per satellite with hover focus ([248918c](https://github.com/gx1400/tautracker/commit/248918c899f056d4fde1ae6d7d6a5634bf0095a6))
* **web:** complete the deferred v1 display requirements ([6cf82bd](https://github.com/gx1400/tautracker/commit/6cf82bd336bfd8c59db994e2e32b28978d2415f5))
* **web:** explain every metric in the UI ([019eabc](https://github.com/gx1400/tautracker/commit/019eabc190597aa481fa892cc3f458fa3fc11077))
* **web:** name the health subsystems under the Health tile ([c6fadb7](https://github.com/gx1400/tautracker/commit/c6fadb75e9c63cb2f79426d70f94b3fa7671cf4c))
* **web:** share one cursor across every chart ([c1b3740](https://github.com/gx1400/tautracker/commit/c1b3740130ca8654c8b63024b7815cf87e0ffd87))
* **web:** show data gaps as gaps instead of interpolating across them ([52ae3c5](https://github.com/gx1400/tautracker/commit/52ae3c5a643d98f47b0bcc0197525f58eb6e3cff))


### Bug Fixes

* **ci:** declare the test dependencies explicitly ([5752982](https://github.com/gx1400/tautracker/commit/57529822e3fe977816fc9e3ff01af9934b703011))
* do not discard a status screen because an error is queued ([7bdb545](https://github.com/gx1400/tautracker/commit/7bdb5456a302604598b05cd263f83168112798fe))
* scale 1PPS TI reported in picoseconds, and add a history backfill tool ([f692318](https://github.com/gx1400/tautracker/commit/f692318ab8c7a2896e46e2bc6e34cf5b6a20de9c))
* serialise access to the shared SQLite connection ([b125eb3](https://github.com/gx1400/tautracker/commit/b125eb344507f2093edf318606b4fd4f86c66a5a))
* **web:** gate the holdover tile on mode, not on duration ([302053a](https://github.com/gx1400/tautracker/commit/302053a017d9faf184b5c9aae98b6a7377cb7759))
* **web:** keep every status tile the same height ([3c75c54](https://github.com/gx1400/tautracker/commit/3c75c54a2bd665cbc0a81e6c221bd15e4ccfb6ec))
* **web:** size the y-axis gutter to its labels, and clamp long tile values ([4b4645a](https://github.com/gx1400/tautracker/commit/4b4645a0405984633f455838c5bfacc740fef409))
* **web:** stop the sky view wasting horizontal space ([24e80b8](https://github.com/gx1400/tautracker/commit/24e80b882d6d27ae58a2ec39d434f5a2c406b60f))


### Documentation

* document installation, transports, configuration and Docker usage ([fd51357](https://github.com/gx1400/tautracker/commit/fd51357ecaed5078458c130d47dfd3ef34157fd7))
