// AppKit がイベントの処理中に投げた Objective-C 例外を受け止める。呼び出し側は `objc_exception.rs`。
//
// tao は NSApplication のサブクラス TaoApp と NSWindow のサブクラス TaoWindow の -sendEvent: を
// Rust の `extern "C"` 関数で上書きし、その中から [super sendEvent:] を呼んでいる。AppKit が
// イベントの処理中に投げた NSException は、普通の Cocoa アプリなら -[NSApplication run] が
// 受け止めて報告するだけで済むが、tao の Rust のフレームを越えようとした時点で Rust が abort する
// (「panic in a function that cannot unwind」)。
//
// tao の super 呼び出しが着く NSApplication と NSWindow 自身の実装を差し替え、例外を Rust の
// フレームに届く前にここで受け止める。受け止めた後は記録してイベントループを続ける。
// NSWindow も包むのは、TaoWindow の -sendEvent: と、TaoApp が Cmd 付きの keyUp を
// [keyWindow sendEvent:] で直接ウィンドウへ送る経路が、NSApplication の -sendEvent: を通らないため。
//
// 受け止められるのは、差し替えた実装から Rust のフレームを挟まずに届いた例外だけ。途中で Rust の
// コールバック (objc2 のメソッド等) に入り、そこから呼んだ AppKit が投げた例外は、ここへ届く前に
// そのフレームで abort する (release が panic = "abort" なので、objc2 の define_class! が出す
// `extern "C-unwind"` のメソッドでも abort する)。
//
// objc2::exception::catch は使わない。閉包を Rust のトランポリン越しに呼ぶので、例外を投げる側と
// 受け止める側の間に Rust のフレームが挟まる (panic = "abort" のビルドではそこで abort する)。

#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static IMP original_app_send_event = NULL;
static IMP original_window_send_event = NULL;
static char *log_path = NULL;

// これより大きくなったら書き直す (落ちずに繰り返し投げられる例外でディスクを埋めない)
static const unsigned long long LOG_LIMIT_BYTES = 1024 * 1024;

static void report(NSString *where, NSString *name, NSString *reason, NSArray *symbols) {
    NSString *version =
        [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"?";
    NSString *entry = [NSString
        stringWithFormat:@"%@ Astragal %@: uncaught %@ in -[%@ sendEvent:]: %@\n%@\n\n", [NSDate date],
                         version, name, where, reason, [symbols componentsJoinedByString:@"\n"]];
    // -reportException: は使わない。NSApplicationCrashOnExceptions が有効だとそこで落ちる
    NSLog(@"%@", entry);

    if (log_path == NULL) {
        return;
    }
    @try {
        NSString *dir = [[NSString stringWithUTF8String:log_path] stringByDeletingLastPathComponent];
        [[NSFileManager defaultManager] createDirectoryAtPath:dir
                                  withIntermediateDirectories:YES
                                                   attributes:nil
                                                        error:NULL];
        // NSFileManager の createFileAtPath: は一時ファイルを経由して置き換えるので使わない (置けない環境がある)
        struct stat st;
        bool too_large = stat(log_path, &st) == 0 && (unsigned long long)st.st_size > LOG_LIMIT_BYTES;
        int fd = open(log_path, O_WRONLY | O_CREAT | O_CLOEXEC | (too_large ? O_TRUNC : O_APPEND), 0644);
        if (fd < 0) {
            return;
        }
        const char *bytes = [entry UTF8String];
        size_t left = strlen(bytes);
        while (left > 0) {
            ssize_t written = write(fd, bytes, left);
            if (written < 0) {
                if (errno == EINTR) {
                    continue;
                }
                break;
            }
            bytes += written;
            left -= (size_t)written;
        }
        close(fd);
    } @catch (id ignored) {
        // ログが書けないことでイベントループを止めない
    }
}

static void call_guarded(NSString *where, IMP original, id self, SEL cmd, NSEvent *event) {
    @try {
        ((void (*)(id, SEL, NSEvent *))original)(self, cmd, event);
    } @catch (NSException *exception) {
        report(where, [exception name], [exception reason], [exception callStackSymbols]);
    } @catch (id other) {
        report(where, NSStringFromClass([other class]), [other description], [NSThread callStackSymbols]);
    }
}

static void guarded_app_send_event(id self, SEL cmd, NSEvent *event) {
    call_guarded(@"NSApplication", original_app_send_event, self, cmd, event);
}

static void guarded_window_send_event(id self, SEL cmd, NSEvent *event) {
    call_guarded(@"NSWindow", original_window_send_event, self, cmd, event);
}

static bool replace(Class cls, IMP *original, IMP guarded) {
    if (*original != NULL) {
        return true;
    }
    Method method = class_getInstanceMethod(cls, @selector(sendEvent:));
    if (method == NULL) {
        return false;
    }
    *original = method_setImplementation(method, guarded);
    return *original != NULL;
}

// 起動時に main スレッドから 1 回呼ぶ。2 回目以降は何もしない。log_file が NULL なら NSLog だけに出す
bool astragal_guard_send_event(const char *log_file) {
    if (log_file != NULL && log_path == NULL) {
        log_path = strdup(log_file);
    }
    bool app = replace([NSApplication class], &original_app_send_event, (IMP)guarded_app_send_event);
    bool window = replace([NSWindow class], &original_window_send_event, (IMP)guarded_window_send_event);
    return app && window;
}
