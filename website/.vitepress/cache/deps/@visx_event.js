import {
  Point
} from "./chunk-PXWL2EMG.js";
import "./chunk-DC5AMYBS.js";

// node_modules/@visx/event/esm/typeGuards.js
function isElement(elem) {
  return !!elem && elem instanceof Element;
}
function isSVGElement(elem) {
  return !!elem && (elem instanceof SVGElement || "ownerSVGElement" in elem);
}
function isSVGSVGElement(elem) {
  return !!elem && "createSVGPoint" in elem;
}
function isSVGGraphicsElement(elem) {
  return !!elem && "getScreenCTM" in elem;
}
function isTouchEvent(event) {
  return !!event && "changedTouches" in event;
}
function isMouseEvent(event) {
  return !!event && "clientX" in event;
}
function isEvent(event) {
  return !!event && (event instanceof Event || "nativeEvent" in event && event.nativeEvent instanceof Event);
}

// node_modules/@visx/event/esm/getXAndYFromEvent.js
var DEFAULT_POINT = {
  x: 0,
  y: 0
};
function getXAndYFromEvent(event) {
  if (!event) return {
    ...DEFAULT_POINT
  };
  if (isTouchEvent(event)) {
    return event.changedTouches.length > 0 ? {
      x: event.changedTouches[0].clientX,
      y: event.changedTouches[0].clientY
    } : {
      ...DEFAULT_POINT
    };
  }
  if (isMouseEvent(event)) {
    return {
      x: event.clientX,
      y: event.clientY
    };
  }
  const target = event == null ? void 0 : event.target;
  const boundingClientRect = target && "getBoundingClientRect" in target ? target.getBoundingClientRect() : null;
  if (!boundingClientRect) return {
    ...DEFAULT_POINT
  };
  return {
    x: boundingClientRect.x + boundingClientRect.width / 2,
    y: boundingClientRect.y + boundingClientRect.height / 2
  };
}

// node_modules/@visx/event/esm/localPointGeneric.js
function localPoint(node, event) {
  if (!node || !event) return null;
  const coords = getXAndYFromEvent(event);
  const svg = isSVGElement(node) ? node.ownerSVGElement : node;
  const screenCTM = isSVGGraphicsElement(svg) ? svg.getScreenCTM() : null;
  if (isSVGSVGElement(svg) && screenCTM) {
    let point = svg.createSVGPoint();
    point.x = coords.x;
    point.y = coords.y;
    point = point.matrixTransform(screenCTM.inverse());
    return new Point({
      x: point.x,
      y: point.y
    });
  }
  const rect = node.getBoundingClientRect();
  return new Point({
    x: coords.x - rect.left - node.clientLeft,
    y: coords.y - rect.top - node.clientTop
  });
}

// node_modules/@visx/event/esm/localPoint.js
function localPoint2(nodeOrEvent, maybeEvent) {
  if (isElement(nodeOrEvent) && maybeEvent) {
    return localPoint(nodeOrEvent, maybeEvent);
  }
  if (isEvent(nodeOrEvent)) {
    const event = nodeOrEvent;
    const node = event.target;
    if (node) return localPoint(node, event);
  }
  return null;
}
export {
  localPoint2 as localPoint,
  localPoint as touchPoint
};
//# sourceMappingURL=@visx_event.js.map
