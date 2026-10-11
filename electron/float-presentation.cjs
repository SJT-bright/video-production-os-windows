'use strict';

// 只计算一次原生包络窗口；逐帧运动交给 Chromium 的 transform/opacity 合成层。
function createFloatPresentation(target, source, id) {
  let origin = source;
  if (!origin || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(origin[key])) || origin.width < 1 || origin.height < 1) origin = null;
  const left = origin ? Math.floor(Math.min(target.x, origin.x)) : target.x;
  const top = origin ? Math.floor(Math.min(target.y, origin.y)) : target.y;
  const right = origin ? Math.ceil(Math.max(target.x + target.width, origin.x + origin.width)) : target.x + target.width;
  const bottom = origin ? Math.ceil(Math.max(target.y + target.height, origin.y + origin.height)) : target.y + target.height;
  if (right - left > 6000 || bottom - top > 4000) return createFloatPresentation(target, null, id);
  return {
    target: { ...target }, bounds: { x: left, y: top, width: right - left, height: bottom - top },
    render: { id, left: target.x - left, top: target.y - top, width: target.width, height: target.height,
      dx: origin ? origin.x - target.x : 0, dy: origin ? origin.y - target.y : 0,
      scaleX: origin ? Math.max(.04, Math.min(2, origin.width / target.width)) : .96,
      scaleY: origin ? Math.max(.04, Math.min(2, origin.height / target.height)) : .96, anchored: !!origin },
  };
}
module.exports = { createFloatPresentation };
