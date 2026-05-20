//
//  DebugBridgeTouch.h — public Objective-C interface for in-process touch
//  synthesis. Implementation derived from KIF (https://github.com/kif-framework/KIF),
//  MIT-licensed. The minimal subset needed to deliver a real UITouch to a
//  point on the key window, including SwiftUI Buttons via iOS 18+
//  _UIHitTestContext. DEBUG-only — never link in Release.

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface DebugBridgeTouch : NSObject

/// Synthesize a single tap (TouchPhaseBegan + TouchPhaseEnded) at the given
/// window-coordinate point. Returns YES if the touch was delivered (a hit
/// view was found and the event passed through UIApplication.sendEvent).
+ (BOOL)sendTapAtPoint:(CGPoint)point inWindow:(UIWindow *)window;

@end

NS_ASSUME_NONNULL_END
