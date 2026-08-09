# Stability & Performance Fix Tasks

- `[x]` Refactor Database Layer (Room & TripStorage)
    - `[x]` Update `TripDao` to return `Flow` (Decided on `suspend` for better integration with existing UI logic)
    - `[x]` Remove `allowMainThreadQueries` from `AppDatabase`
    - `[x]` Make `TripStorage` methods `suspend` or background-safe
- `[x]` Refactor State Bridges to `StateFlow`
    - `[x]` `ScanningBridge.kt`
    - `[x]` `location/MileageBridge.kt`
- `[x]` Fix Service Stability
    - `[x]` `MileageTrackingService.kt`: Android 14 Foreground Service Type
    - `[x]` Ensure background scope for service DB calls
- `[x]` Update `MainActivity.kt`
    - `[x]` Observe database (Reload via `tripSavedTick` trigger)
    - `[x]` Update bridge interactions to `StateFlow` (via `AppState.sync`)
    - `[x]` Switch settings `commit()` to `apply()`
- `[x]` Verify build and stability
