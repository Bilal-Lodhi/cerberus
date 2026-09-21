/// Non-web stub for [documentVisibilityState].
///
/// Selected when `dart:library.html` is unavailable, i.e. for the Dart VM and
/// therefore for `flutter test`. There is no browser document to query, so the
/// telemetry payload carries `'unknown'` exactly as the web path does when the
/// document is unreachable.
library;

/// Always returns `'unknown'` off the web.
String documentVisibilityState() => 'unknown';
