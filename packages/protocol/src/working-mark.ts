export const WORKING_MARK_ANIMATION = "mirror:working-mark-animation";

export interface WorkingMarkTrack {
  frames: {
    offset: number;
    easing: string;
    transform?: string;
    opacity?: string;
  }[];
  duration: number;
  easing: string;
  iterations: number | null; // null represents Infinity on the wire.
  time: number;
  paused: boolean;
}

export interface WorkingMarkUpdate {
  id: number;
  tracks: WorkingMarkTrack[];
}
