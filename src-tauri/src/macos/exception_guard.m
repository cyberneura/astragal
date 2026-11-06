// NSApplication の -sendEvent: で投げられた Objective-C 例外を受け止める
// (CYBERNEURA-DEV-1204)。呼び出し側は `objc_exception.rs`。
//
// tao は NSApplication のサブクラス TaoApp の -sendEvent: を Rust の `extern "C"`
// 関数で上書きし、その中から [super sendEvent:] を呼んでいる。AppKit がイベントの
// 処理中に投げた NSException は、普通の Cocoa アプリなら -[NSApplication run] が
// 受け止めて報告するだけで済むが、tao の Rust のフレームを越えようとした時点で
// Rust が abort する (「panic in a function that cannot unwind」)。
//
// tao の super 呼び出しが着く NSApplication 自身の実装を差し替え、例外を Rust の
// フレームに届く前にここで受け止める。受け止めた後は記録してイベントループを続ける
// (AppKit の既定の -[NSApplication run] と同じ扱い)。
//
// 受け止められるのは、NSApplication の -sendEvent: から Rust のフレームを挟まずに
// 届いた例外だけ。途中で Rust のコールバック (objc2 のメソッド等) に入り、そこから
// 呼んだ AppKit が投げた例外は、ここへ届く前にそのフレームで abort する。
//
// 受け止めるのは全部の NSException。-abortModal の NSAbortModalException のように
// 外側で受け止められる前提の例外もここで止まるが、差し替える前はどれも tao の
// フレームで abort していたので、止まる方が悪くなることは無い。
//
// objc2::exception::catch は使えない。閉包を Rust のトランポリン越しに呼ぶので、
// release の panic = "abort" では例外がそのトランポリンを通る時点で abort する。
// 例外を投げる側と受け止める側の間に Rust のフレームを挟まないため、ここだけ
// Objective-C で書いている。

#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <stdbool.h>

static IMP original_send_event = NULL;

// これより大きくなったら書き直す (落ちずに繰り返し投げられる例外でディスクを埋めない)
static const unsigned long long LOG_LIMIT_BYTES = 1024 * 1024;

static void append_to_log(NSException *exception) {
    @try {
        NSString *dir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/Astragal"];
        NSFileManager *fm = [NSFileManager defaultManager];
        if (![fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL]) {
            return;
        }
        NSString *path = [dir stringByAppendingPathComponent:@"exceptions.log"];
        NSDictionary *attrs = [fm attributesOfItemAtPath:path error:NULL];
        if (attrs == nil || [attrs fileSize] > LOG_LIMIT_BYTES) {
            [fm createFileAtPath:path contents:[NSData data] attributes:nil];
        }

        NSString *version =
            [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"?";
        NSString *entry = [NSString
            stringWithFormat:@"%@ Astragal %@: uncaught %@ while handling an event: %@\n%@\n\n",
                             [NSDate date], version, [exception name], [exception reason],
                             [[exception callStackSymbols] componentsJoinedByString:@"\n"]];

        NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
        if (handle == nil) {
            return;
        }
        [handle seekToEndOfFile];
        [handle writeData:[entry dataUsingEncoding:NSUTF8StringEncoding]];
        [handle closeFile];
    } @catch (NSException *ignored) {
        // ログが書けないことでイベントループを止めない
    }
}

static void guarded_send_event(id self, SEL cmd, NSEvent *event) {
    @try {
        ((void (*)(id, SEL, NSEvent *))original_send_event)(self, cmd, event);
    } @catch (NSException *exception) {
        append_to_log(exception);
        // -reportException: は使わない。NSApplicationCrashOnExceptions が有効だと
        // そこで落ちるので、続けるという目的を果たせない
        NSLog(@"Astragal: uncaught %@ while handling an event: %@\n%@", [exception name],
              [exception reason], [exception callStackSymbols]);
    }
}

// 起動時に main スレッドから 1 回呼ぶ。2 回目以降は何もしない。
bool astragal_guard_send_event(void) {
    if (original_send_event != NULL) {
        return true;
    }
    Method method = class_getInstanceMethod([NSApplication class], @selector(sendEvent:));
    if (method == NULL) {
        return false;
    }
    original_send_event = method_setImplementation(method, (IMP)guarded_send_event);
    return original_send_event != NULL;
}
