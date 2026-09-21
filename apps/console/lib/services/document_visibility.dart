/// Document-visibility access that compiles on every Flutter target.
///
/// `dart:html` is only available when compiling for the web. Importing it
/// directly makes the whole widget tree un-compilable for the Dart VM, which
/// means `flutter test` cannot run at all. This conditional export keeps the
/// web behaviour intact while giving the VM a stub.
///
/// Usage:
///   import '../services/document_visibility.dart';
///   final state = documentVisibilityState(); // 'visible' | 'hidden' | 'unknown'
library;

export 'document_visibility_stub.dart'
    if (dart.library.html) 'document_visibility_web.dart';
