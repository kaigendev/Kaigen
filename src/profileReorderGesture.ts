type ProfileGesture = { pointerId: number; profileId: string; x: number; y: number; dragging: boolean };

/** Pointer-only ordering avoids Windows WebView's native file-drop/OLE loop. */
export class ProfileReorderGesture {
  private gesture: ProfileGesture | null = null;

  owns(pointerId: number): boolean { return this.gesture?.pointerId === pointerId; }

  begin(pointerId: number, profileId: string, x: number, y: number): boolean {
    if (this.gesture) return false;
    this.gesture = { pointerId, profileId, x, y, dragging: false };
    return true;
  }

  move(pointerId: number, x: number, y: number): string | null {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== pointerId) return null;
    if (Math.hypot(x - gesture.x, y - gesture.y) >= 6) gesture.dragging = true;
    return gesture.dragging ? gesture.profileId : null;
  }

  finish(pointerId: number): string | null {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== pointerId) return null;
    this.gesture = null;
    return gesture.dragging ? gesture.profileId : null;
  }

  cancel(): void { this.gesture = null; }
}
