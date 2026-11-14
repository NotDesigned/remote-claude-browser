export interface Screen {
  width: number;
  height: number;
}

export const DEFAULT_SCREEN: Screen = { width: 1920, height: 1080 };

/** The account's own screen, not the shared X display the browser's windows are placed on. */
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
