#import <AppKit/AppKit.h>
#import <sys/file.h>
#import <fcntl.h>
#import <unistd.h>

static int fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    return 1;
}

static BOOL run(NSString *command, NSArray<NSString *> *arguments) {
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:command];
    task.arguments = arguments;
    task.standardOutput = [NSFileHandle fileHandleWithNullDevice];
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) return NO;
    [task waitUntilExit];
    return task.terminationStatus == 0;
}

static BOOL running(NSString *app) {
    NSTask *task = [NSTask new];
    NSPipe *output = [NSPipe pipe];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/ps"];
    task.arguments = @[@"-axww", @"-o", @"comm="];
    task.standardOutput = output;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) return YES;
    NSData *data = [output.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    if (task.terminationStatus != 0) return YES;
    NSString *prefix = [[app stringByResolvingSymlinksInPath] stringByAppendingString:@"/"];
    NSString *commands = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    for (NSString *line in [commands componentsSeparatedByString:@"\n"]) {
        if ([[line stringByResolvingSymlinksInPath] hasPrefix:prefix]) return YES;
    }
    return NO;
}

static NSDictionary *identity(NSString *source, NSString *revision) {
    NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:[source stringByAppendingPathComponent:@"Contents/Info.plist"]];
    if (![info[@"CFBundleIdentifier"] isEqual:@"com.google.Chrome"] || !info[@"CFBundleVersion"] || !info[@"CFBundleShortVersionString"]) return nil;
    return @{@"source": source, @"version": info[@"CFBundleVersion"], @"release": info[@"CFBundleShortVersionString"], @"revision": revision};
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 5) return fail(@"Usage: browser-icon source.app cache-directory icon.png revision");
        NSFileManager *files = [NSFileManager defaultManager];
        NSString *source = [[NSString stringWithUTF8String:argv[1]] stringByResolvingSymlinksInPath];
        NSString *root = [NSString stringWithUTF8String:argv[2]];
        NSString *iconPath = [NSString stringWithUTF8String:argv[3]];
        NSString *revision = [NSString stringWithUTF8String:argv[4]];
        NSDictionary *wanted = identity(source, revision);
        if (!wanted) return fail(@"Branding requires an installed Google Chrome application");
        NSError *error = nil;
        if (![files createDirectoryAtPath:root withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:&error]) return fail(error.localizedDescription);
        char *resolved = realpath(root.fileSystemRepresentation, NULL);
        if (!resolved) return fail(@"Could not resolve the browser app directory");
        root = [NSString stringWithUTF8String:resolved];
        free(resolved);
        int lock = open([[root stringByAppendingPathComponent:@"prepare.lock"] fileSystemRepresentation], O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
        if (lock < 0 || flock(lock, LOCK_EX) != 0) return fail(@"Could not lock browser app preparation");
        NSArray<NSString *> *entries = [files contentsOfDirectoryAtPath:root error:&error];
        if (!entries) return fail(error.localizedDescription);
        NSString *ready = nil;
        for (NSString *entry in entries) {
            NSString *directory = [root stringByAppendingPathComponent:entry];
            if ([entry hasPrefix:@".prepare-"]) {
                [files removeItemAtPath:directory error:nil];
                continue;
            }
            if (![entry hasPrefix:@"version-"]) continue;
            NSDictionary *stored = [NSDictionary dictionaryWithContentsOfFile:[directory stringByAppendingPathComponent:@"identity.plist"]];
            NSString *app = [directory stringByAppendingPathComponent:@"Cast Agent Chrome.app"];
            if ([stored isEqual:wanted] && [files isExecutableFileAtPath:[app stringByAppendingPathComponent:@"Contents/MacOS/Google Chrome"]]) ready = app;
        }
        if (ready && !run(@"/usr/bin/codesign", @[@"--verify", @"--deep", ready])) ready = nil;
        if (!ready) {
            NSImage *icon = [[NSImage alloc] initWithContentsOfFile:iconPath];
            if (!icon) return fail(@"Could not read the Cast Agent Chrome icon");
            NSString *token = NSUUID.UUID.UUIDString;
            NSString *stage = [root stringByAppendingPathComponent:[@".prepare-" stringByAppendingString:token]];
            NSString *candidate = [stage stringByAppendingPathComponent:@"Cast Agent Chrome.app"];
            if (![files createDirectoryAtPath:stage withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions: @0700} error:&error]) return fail(error.localizedDescription);
            if (!run(@"/bin/cp", @[@"-cR", source, candidate])) return fail(@"Could not copy Chrome for agent branding");
            if (!run(@"/usr/bin/codesign", @[@"--verify", @"--deep", candidate])) return fail(@"The copied Chrome application did not pass signature validation");
            if (![wanted isEqual:identity(source, revision)]) return fail(@"Chrome updated during preparation; the next launch will retry");
            if (![[NSWorkspace sharedWorkspace] setIcon:icon forFile:candidate options:0]) return fail(@"macOS could not apply the agent browser icon");
            if (![wanted writeToFile:[stage stringByAppendingPathComponent:@"identity.plist"] atomically:YES]) return fail(@"Could not save the browser app identity");
            NSString *destination = [root stringByAppendingPathComponent:[@"version-" stringByAppendingString:token]];
            if (rename(stage.fileSystemRepresentation, destination.fileSystemRepresentation) != 0) return fail(@"Could not finish browser app preparation");
            ready = [destination stringByAppendingPathComponent:@"Cast Agent Chrome.app"];
        }
        for (NSString *entry in entries) {
            if (![entry hasPrefix:@"version-"]) continue;
            NSString *directory = [root stringByAppendingPathComponent:entry];
            NSString *app = [directory stringByAppendingPathComponent:@"Cast Agent Chrome.app"];
            if (![app isEqual:ready] && !running(app)) [files removeItemAtPath:directory error:nil];
        }
        puts(ready.UTF8String);
        return 0;
    }
}
