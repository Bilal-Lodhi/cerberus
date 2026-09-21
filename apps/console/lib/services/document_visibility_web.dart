/// Web implementation of [documentVisibilityState].
///
/// Selected by the conditional export in `document_visibility.dart` when
/// compiling for the web (`dart.library.html` is available).
///
/// `dart:html` is deprecated in favour of `package:web` + `dart:js_interop`,
/// and the analyzer flags any web-only library used outside a web plugin. Both
/// are inherent to this file's purpose and are scoped to it deliberately, so
/// the rest of the console stays portable and `flutter test` can run on the VM.
library;

// ignore_for_file: deprecated_member_use, avoid_web_libraries_in_flutter

import 'dart:html' as html;

/// Returns the browser's current document visibility state.
///
/// Falls back to `'unknown'` when the document is not reachable, which is the
/// same behaviour the previous inline implementation had.
String documentVisibilityState() {
  try {
    return html.document.visibilityState;
  } catch (_) {
    return 'unknown';
  }
}
