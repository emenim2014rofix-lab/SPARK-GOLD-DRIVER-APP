# Production-Quality Stability & Performance Audit Plan

This plan addresses confirmed issues in the DriverApp project that cause instability, freezes, and crashes on real Android devices.

## Confirmed Critical Issues

### 1. Main Thread Database Operations (ANR Risk)
- **Problem**: `TripStorage` performs Room database queries and migrations directly on the Main thread. `MainActivity` calls these methods inside `remember` blocks and `LaunchedEffect`.
- **Impact**: UI freezes during startup and whenever a trip is saved. High probability of ANR (Application Not Responding) as history grows.
- **Fix**: Refactor `TripStorage` to use `CoroutineContext` (Dispatchers.IO) and expose data via `Flow` or `suspend` functions.

### 2. Foreground Service Crashes (Android 14 Compatibility)
- **Problem**: `MileageTrackingService.startForeground()` does not specify the `FOREGROUND_SERVICE_TYPE_LOCATION` parameter.
- **Impact**: **Immediate crash** on Android 14 (API 34) when tracking starts.
- **Fix**: Update `startForeground` to include the required service type.

### 3. Background Service Start Violations (Android 12+ Compatibility)
- **Problem**: `MainActivity` uses an Activity-scoped `LocationTracker` to detect driving starts. When it fires, it calls `startForegroundService`. If the Activity is in the background, this is prohibited.
- **Impact**: **Crash** (`ForegroundServiceStartNotAllowedException`) when auto-start triggers while the app is minimized.
- **Fix**: Move auto-start detection to a more appropriate background mechanism or handle the exception and notify the user.

### 4. Excessive Synchronous Disk I/O (ANR Risk)
- **Problem**: `MainActivity` uses `commit()` instead of `apply()` inside a `LaunchedEffect` that watches 20+ fields.
- **Impact**: Every UI state change (even small ones) blocks the main thread to write to disk.
- **Fix**: Switch to `apply()` and debounced persistence.

### 5. Architectural Memory Leaks & State Sync Issues
- **Problem**: `ScanningBridge` and `MileageBridge` singletons hold references to `MutableState` objects managed by the Activity.
- **Impact**: Memory leaks if the Activity is destroyed/recreated (e.g., rotation). State desync where the UI shows stale data from a dead Activity instance.
- **Fix**: Refactor bridges to use standard Kotlin `Flow` or `StateFlow` and decouple from Compose `MutableState` in singletons.

## Proposed Changes

### [Component] Database Layer (`location/TripDatabase.kt`, `location/TripStorage.kt`)
- Remove `allowMainThreadQueries()` from `AppDatabase`.
- Change `TripDao.getAll()` to return a `Flow<List<TripEntity>>`.
- Make `TripStorage.save` a `suspend` function using `withContext(Dispatchers.IO)`.

### [Component] Services (`service/MileageTrackingService.kt`, `service/OverlayService.kt`)
- Update `MileageTrackingService` to use `ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION`.
- Ensure all database interactions in services use a background scope.

### [Component] Bridges (`ScanningBridge.kt`, `location/MileageBridge.kt`)
- Replace `MutableState` properties with `MutableStateFlow`.
- Update all call sites to use `.value` or `.emit()`.

### [Component] Main Activity (`MainActivity.kt`)
- Observe `TripStorage` as a `Flow` using `collectAsState`.
- Replace `commit()` with `apply()` for SharedPreferences.
- Fix the `savingTrip` state persistence bug.

## Verification Plan

### Automated Tests
- Build project using `./gradlew assembleDebug`.
- Verify no `IllegalStateException` for Main Thread queries.

### Manual Verification
- Deploy to a real device (ideally Android 14).
- Toggle Tracking and verify it doesn't crash.
- Observe UI responsiveness during large history loads.
- Verify "Saving trip..." message disappears after save completes.
