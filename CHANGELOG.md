# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the zones of a Nobø Hub over its local API v1.1 (TCP 27779),
  found by its UDP announcement or a fixed address; temperature, comfort and
  eco temperatures, mode and mode in force of each zone, mode of the whole
  house.
- Commands off by default: modes (comfort, eco, week profile) and temperatures
  (whole numbers, 7 to 30 °C), each confirmed by the answer of the hub; the
  away mode (anti-frost) always allowed, kept in `/data` until confirmed.
