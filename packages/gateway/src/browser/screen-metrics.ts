/** The shared X display is a placement canvas, not one physical monitor per browser tab. */
export function screenMetrics(width: number, height: number, mobile: boolean) {
  return {
    screenWidth: mobile ? width : Math.max(1920, width),
    screenHeight: mobile ? height : Math.max(1080, height),
    positionX: 0,
    positionY: 0,
  };
}
