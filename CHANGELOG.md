# unipls

## 0.2.0

### Minor Changes

- b984d98: Add a configurable exponential backoff reconnector with jitter and a retry limit.
- d3d9f75: Add structured detector drop reasons and immutable JSON metadata. Add BrowserLifecycleDropDetector and BrowserLifecycleReconnector with a shared browser event source, probes after lifecycle transitions, and reason-based recovery with a configurable default reconnector for other drops.
- 2afb687: Allow configuring a retry limit for `ImmediateReconnector`.
- 550dbbb: Move reconnection policies and drop detectors to dedicated public entry points. Import them from `unipls/reconnectors` and `unipls/drop-detectors` instead of `unipls` or `unipls/browser`.
- 7a28c6b: Rename the stream callback option from `onMessage` to `onMatch` to clarify that it runs for messages accepted by the selector.
