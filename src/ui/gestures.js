// Shared pointer-gesture wiring. Wraps a pointerdown + move/up/cancel lifecycle
// with pointer capture and guaranteed teardown, so an interrupted gesture (touch
// cancel, window blur) never leaves move listeners, drag state, or the cancel
// hook stuck. Canvas card drag/resize and the reader edit grip all share it.
export var activePointerGestures = new Set();

export function onPointerGesture(handle, onDown, onMove, onUp, scope){
  function pointerDown(e){
    if (!onDown(e)) return;
    try { handle.setPointerCapture(e.pointerId); } catch(_e){}
    function move(ev){ if (ev.pointerId === e.pointerId) onMove(ev); }
    function finish(){
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      handle.removeEventListener("lostpointercapture", done);
      activePointerGestures.delete(cancel);
      try { handle.releasePointerCapture(e.pointerId); } catch(_e){}
      onUp();
    }
    function done(ev){ if (ev.pointerId === e.pointerId) finish(); }
    function cancel(){ finish(); }
    activePointerGestures.add(cancel);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
    handle.addEventListener("lostpointercapture", done);
  }
  if (scope) scope.listen(handle, "pointerdown", pointerDown);
  else handle.addEventListener("pointerdown", pointerDown);
}
