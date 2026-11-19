export interface Screen {
  width: number;
  height: number;
}

export const DEFAULT_SCREEN: Screen = { width: 1920, height: 1080 };

/** Screen dimensions use the logical page viewport before capture magnification. */
export function screenMetrics(
  width: number,
  height: number,
  mobile: boolean,
  screen: Screen = DEFAULT_SCREEN,
) {
  return {
    screenWidth: mobile ? width : Math.max(screen.width, width),
    screenHeight: mobile ? height : Math.max(screen.height, height),
    positionX: 0,
    positionY: 0,
  };
}
