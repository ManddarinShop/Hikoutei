import {
  require_jsx_runtime
} from "./chunk-JNOOTWYN.js";
import {
  require_react
} from "./chunk-CVCTGI67.js";
import {
  arc_default,
  area_default,
  ascending_default,
  descending_default,
  diverging_default,
  expand_default,
  insideOut_default,
  lineRadial_default,
  line_default,
  linkHorizontal,
  linkRadial,
  linkVertical,
  none_default,
  none_default2,
  path,
  pie_default,
  reverse_default,
  silhouette_default,
  stack_default,
  wiggle_default
} from "./chunk-X6Z6NCW2.js";
import {
  __commonJS,
  __toESM
} from "./chunk-DC5AMYBS.js";

// node_modules/classnames/index.js
var require_classnames = __commonJS({
  "node_modules/classnames/index.js"(exports, module) {
    (function() {
      "use strict";
      var hasOwn = {}.hasOwnProperty;
      function classNames() {
        var classes = "";
        for (var i = 0; i < arguments.length; i++) {
          var arg = arguments[i];
          if (arg) {
            classes = appendClass(classes, parseValue(arg));
          }
        }
        return classes;
      }
      function parseValue(arg) {
        if (typeof arg === "string" || typeof arg === "number") {
          return arg;
        }
        if (typeof arg !== "object") {
          return "";
        }
        if (Array.isArray(arg)) {
          return classNames.apply(null, arg);
        }
        if (arg.toString !== Object.prototype.toString && !arg.toString.toString().includes("[native code]")) {
          return arg.toString();
        }
        var classes = "";
        for (var key in arg) {
          if (hasOwn.call(arg, key) && arg[key]) {
            classes = appendClass(classes, key);
          }
        }
        return classes;
      }
      function appendClass(value, newClass) {
        if (!newClass) {
          return value;
        }
        if (value) {
          return value + " " + newClass;
        }
        return value + newClass;
      }
      if (typeof module !== "undefined" && module.exports) {
        classNames.default = classNames;
        module.exports = classNames;
      } else if (typeof define === "function" && typeof define.amd === "object" && define.amd) {
        define("classnames", [], function() {
          return classNames;
        });
      } else {
        window.classNames = classNames;
      }
    })();
  }
});

// node_modules/@visx/shape/esm/shapes/Arc.js
var import_classnames = __toESM(require_classnames());

// node_modules/@visx/shape/esm/util/setNumberOrNumberAccessor.js
function setNumberOrNumberAccessor(func, value) {
  if (typeof value === "number") func(value);
  else func(value);
}

// node_modules/@visx/shape/esm/util/stackOrder.js
var STACK_ORDERS = {
  ascending: ascending_default,
  descending: descending_default,
  insideout: insideOut_default,
  none: none_default2,
  reverse: reverse_default
};
var STACK_ORDER_NAMES = Object.keys(STACK_ORDERS);
function stackOrder(order) {
  return order && STACK_ORDERS[order] || STACK_ORDERS.none;
}

// node_modules/@visx/shape/esm/util/stackOffset.js
var STACK_OFFSETS = {
  expand: expand_default,
  diverging: diverging_default,
  none: none_default,
  silhouette: silhouette_default,
  wiggle: wiggle_default
};
var STACK_OFFSET_NAMES = Object.keys(STACK_OFFSETS);
function stackOffset(offset) {
  return offset && STACK_OFFSETS[offset] || STACK_OFFSETS.none;
}

// node_modules/@visx/shape/esm/util/D3ShapeFactories.js
function arc() {
  let {
    innerRadius,
    outerRadius,
    cornerRadius,
    startAngle,
    endAngle,
    padAngle,
    padRadius
  } = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
  const path2 = arc_default();
  if (innerRadius != null) setNumberOrNumberAccessor(path2.innerRadius, innerRadius);
  if (outerRadius != null) setNumberOrNumberAccessor(path2.outerRadius, outerRadius);
  if (cornerRadius != null) setNumberOrNumberAccessor(path2.cornerRadius, cornerRadius);
  if (startAngle != null) setNumberOrNumberAccessor(path2.startAngle, startAngle);
  if (endAngle != null) setNumberOrNumberAccessor(path2.endAngle, endAngle);
  if (padAngle != null) setNumberOrNumberAccessor(path2.padAngle, padAngle);
  if (padRadius != null) setNumberOrNumberAccessor(path2.padRadius, padRadius);
  return path2;
}
function area() {
  let {
    x,
    x0,
    x1,
    y,
    y0,
    y1,
    defined,
    curve
  } = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
  const path2 = area_default();
  if (x) setNumberOrNumberAccessor(path2.x, x);
  if (x0) setNumberOrNumberAccessor(path2.x0, x0);
  if (x1) setNumberOrNumberAccessor(path2.x1, x1);
  if (y) setNumberOrNumberAccessor(path2.y, y);
  if (y0) setNumberOrNumberAccessor(path2.y0, y0);
  if (y1) setNumberOrNumberAccessor(path2.y1, y1);
  if (defined) path2.defined(defined);
  if (curve) path2.curve(curve);
  return path2;
}
function line() {
  let {
    x,
    y,
    defined,
    curve
  } = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
  const path2 = line_default();
  if (x) setNumberOrNumberAccessor(path2.x, x);
  if (y) setNumberOrNumberAccessor(path2.y, y);
  if (defined) path2.defined(defined);
  if (curve) path2.curve(curve);
  return path2;
}
function pie() {
  let {
    startAngle,
    endAngle,
    padAngle,
    value,
    sort,
    sortValues
  } = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
  const path2 = pie_default();
  if (sortValues !== void 0) {
    path2.sortValues(sortValues);
  } else if (sort === void 0) {
    path2.sortValues(null);
  } else if (sort === null) {
    path2.sort(null);
  } else {
    path2.sort(sort);
  }
  if (value != null) path2.value(value);
  if (padAngle != null) setNumberOrNumberAccessor(path2.padAngle, padAngle);
  if (startAngle != null) setNumberOrNumberAccessor(path2.startAngle, startAngle);
  if (endAngle != null) setNumberOrNumberAccessor(path2.endAngle, endAngle);
  return path2;
}
function radialLine() {
  let {
    angle,
    radius,
    defined,
    curve
  } = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
  const path2 = lineRadial_default();
  if (angle) setNumberOrNumberAccessor(path2.angle, angle);
  if (radius) setNumberOrNumberAccessor(path2.radius, radius);
  if (defined) path2.defined(defined);
  if (curve) path2.curve(curve);
  return path2;
}
function stack(_ref) {
  let {
    keys,
    value,
    order,
    offset
  } = _ref;
  const path2 = stack_default();
  if (keys) path2.keys(keys);
  if (value) setNumberOrNumberAccessor(path2.value, value);
  if (order) path2.order(stackOrder(order));
  if (offset) path2.offset(stackOffset(offset));
  return path2;
}

// node_modules/@visx/shape/esm/shapes/Arc.js
var import_jsx_runtime = __toESM(require_jsx_runtime());
function Arc(_ref) {
  let {
    className,
    data,
    innerRadius,
    outerRadius,
    cornerRadius,
    startAngle,
    endAngle,
    padAngle,
    padRadius,
    children,
    innerRef,
    ...restProps
  } = _ref;
  const path2 = arc({
    innerRadius,
    outerRadius,
    cornerRadius,
    startAngle,
    endAngle,
    padAngle,
    padRadius
  });
  if (children) return (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, {
    children: children({
      path: path2
    })
  });
  if (!data && (startAngle == null || endAngle == null || innerRadius == null || outerRadius == null)) {
    console.warn("[@visx/shape/Arc]: expected data because one of startAngle, endAngle, innerRadius, outerRadius is undefined. Bailing.");
    return null;
  }
  return (0, import_jsx_runtime.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames.default)("visx-arc", className),
    d: path2(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/Pie.js
var import_classnames3 = __toESM(require_classnames());

// node_modules/@visx/group/esm/Group.js
var import_classnames2 = __toESM(require_classnames());
var import_jsx_runtime2 = __toESM(require_jsx_runtime());
function Group(_ref) {
  let {
    top = 0,
    left = 0,
    transform,
    className,
    children,
    innerRef,
    ...restProps
  } = _ref;
  return (0, import_jsx_runtime2.jsx)("g", {
    ref: innerRef,
    className: (0, import_classnames2.default)("visx-group", className),
    transform: transform || `translate(${left}, ${top})`,
    ...restProps,
    children
  });
}

// node_modules/@visx/shape/esm/shapes/Pie.js
var import_jsx_runtime3 = __toESM(require_jsx_runtime());
function Pie(_ref) {
  let {
    className,
    top,
    left,
    data = [],
    centroid,
    innerRadius = 0,
    outerRadius,
    cornerRadius,
    startAngle,
    endAngle,
    padAngle,
    padRadius,
    pieSort,
    pieSortValues,
    pieValue,
    children,
    fill = "",
    ...restProps
  } = _ref;
  const path2 = arc({
    innerRadius,
    outerRadius,
    cornerRadius,
    padRadius
  });
  const pie2 = pie({
    startAngle,
    endAngle,
    padAngle,
    value: pieValue,
    sort: pieSort,
    sortValues: pieSortValues
  });
  const arcs = pie2(data);
  if (children) return (0, import_jsx_runtime3.jsx)(import_jsx_runtime3.Fragment, {
    children: children({
      arcs,
      path: path2,
      pie: pie2
    })
  });
  return (0, import_jsx_runtime3.jsx)(Group, {
    className: "visx-pie-arcs-group",
    top,
    left,
    children: arcs.map((arc2, i) => (0, import_jsx_runtime3.jsxs)("g", {
      children: [(0, import_jsx_runtime3.jsx)("path", {
        className: (0, import_classnames3.default)("visx-pie-arc", className),
        d: path2(arc2) || "",
        fill: fill == null || typeof fill === "string" ? fill : fill(arc2),
        ...restProps
      }), centroid == null ? void 0 : centroid(path2.centroid(arc2), arc2)]
    }, `pie-arc-${i}`))
  });
}

// node_modules/@visx/shape/esm/shapes/Line.js
var import_classnames4 = __toESM(require_classnames());
var import_jsx_runtime4 = __toESM(require_jsx_runtime());
function Line(_ref) {
  let {
    from = {
      x: 0,
      y: 0
    },
    to = {
      x: 1,
      y: 1
    },
    fill = "transparent",
    className,
    innerRef,
    ...restProps
  } = _ref;
  const isRectilinear = from.x === to.x || from.y === to.y;
  return (0, import_jsx_runtime4.jsx)("line", {
    ref: innerRef,
    className: (0, import_classnames4.default)("visx-line", className),
    x1: from.x,
    y1: from.y,
    x2: to.x,
    y2: to.y,
    fill,
    shapeRendering: isRectilinear ? "crispEdges" : "auto",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/LinePath.js
var import_classnames5 = __toESM(require_classnames());
var import_jsx_runtime5 = __toESM(require_jsx_runtime());
function LinePath(_ref) {
  let {
    children,
    data = [],
    x,
    y,
    fill = "transparent",
    className,
    curve,
    innerRef,
    defined = () => true,
    ...restProps
  } = _ref;
  const path2 = line({
    x,
    y,
    defined,
    curve
  });
  if (children) return (0, import_jsx_runtime5.jsx)(import_jsx_runtime5.Fragment, {
    children: children({
      path: path2
    })
  });
  return (0, import_jsx_runtime5.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames5.default)("visx-linepath", className),
    d: path2(data) || "",
    fill,
    strokeLinecap: "round",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/LineRadial.js
var import_classnames6 = __toESM(require_classnames());
var import_jsx_runtime6 = __toESM(require_jsx_runtime());
function LineRadial(_ref) {
  let {
    className,
    angle,
    radius,
    defined,
    curve,
    data = [],
    innerRef,
    children,
    fill = "transparent",
    ...restProps
  } = _ref;
  const path2 = radialLine({
    angle,
    radius,
    defined,
    curve
  });
  if (children) return (0, import_jsx_runtime6.jsx)(import_jsx_runtime6.Fragment, {
    children: children({
      path: path2
    })
  });
  return (0, import_jsx_runtime6.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames6.default)("visx-line-radial", className),
    d: path2(data) || "",
    fill,
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/Area.js
var import_classnames7 = __toESM(require_classnames());
var import_jsx_runtime7 = __toESM(require_jsx_runtime());
function Area(_ref) {
  let {
    children,
    x,
    x0,
    x1,
    y,
    y0,
    y1,
    data = [],
    defined = () => true,
    className,
    curve,
    innerRef,
    ...restProps
  } = _ref;
  const path2 = area({
    x,
    x0,
    x1,
    y,
    y0,
    y1,
    defined,
    curve
  });
  if (children) return (0, import_jsx_runtime7.jsx)(import_jsx_runtime7.Fragment, {
    children: children({
      path: path2
    })
  });
  return (0, import_jsx_runtime7.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames7.default)("visx-area", className),
    d: path2(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/AreaClosed.js
var import_classnames8 = __toESM(require_classnames());
var import_jsx_runtime8 = __toESM(require_jsx_runtime());
function AreaClosed(_ref) {
  let {
    x,
    x0,
    x1,
    y,
    y1,
    y0,
    yScale,
    data = [],
    defined = () => true,
    className,
    curve,
    innerRef,
    children,
    ...restProps
  } = _ref;
  const path2 = area({
    x,
    x0,
    x1,
    defined,
    curve
  });
  if (y0 == null) {
    path2.y0(yScale.range()[0]);
  } else {
    setNumberOrNumberAccessor(path2.y0, y0);
  }
  if (y && !y1) setNumberOrNumberAccessor(path2.y1, y);
  if (y1 && !y) setNumberOrNumberAccessor(path2.y1, y1);
  if (children) return (0, import_jsx_runtime8.jsx)(import_jsx_runtime8.Fragment, {
    children: children({
      path: path2
    })
  });
  return (0, import_jsx_runtime8.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames8.default)("visx-area-closed", className),
    d: path2(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/AreaStack.js
var import_classnames10 = __toESM(require_classnames());

// node_modules/@visx/shape/esm/shapes/Stack.js
var import_classnames9 = __toESM(require_classnames());
var import_jsx_runtime9 = __toESM(require_jsx_runtime());
function Stack(_ref) {
  let {
    className,
    top,
    left,
    keys,
    data,
    curve,
    defined,
    x,
    x0,
    x1,
    y0,
    y1,
    value,
    order,
    offset,
    color,
    children,
    ...restProps
  } = _ref;
  const stack2 = stack({
    keys,
    value,
    order,
    offset
  });
  const path2 = area({
    x,
    x0,
    x1,
    y0,
    y1,
    curve,
    defined
  });
  const stacks = stack2(data);
  if (children) return (0, import_jsx_runtime9.jsx)(import_jsx_runtime9.Fragment, {
    children: children({
      stacks,
      path: path2,
      stack: stack2
    })
  });
  return (0, import_jsx_runtime9.jsx)(Group, {
    top,
    left,
    children: stacks.map((series, i) => (0, import_jsx_runtime9.jsx)("path", {
      className: (0, import_classnames9.default)("visx-stack", className),
      d: path2(series) || "",
      fill: color == null ? void 0 : color(series.key, i),
      ...restProps
    }, `stack-${i}-${series.key || ""}`))
  });
}

// node_modules/@visx/shape/esm/shapes/AreaStack.js
var import_jsx_runtime10 = __toESM(require_jsx_runtime());
function AreaStack(_ref) {
  let {
    className,
    top,
    left,
    keys,
    data,
    curve,
    defined,
    x,
    x0,
    x1,
    y0,
    y1,
    value,
    order,
    offset,
    color,
    children,
    ...restProps
  } = _ref;
  return (0, import_jsx_runtime10.jsx)(Stack, {
    className,
    top,
    left,
    keys,
    data,
    curve,
    defined,
    x,
    x0,
    x1,
    y0,
    y1,
    value,
    order,
    offset,
    color,
    ...restProps,
    children: children || ((_ref2) => {
      let {
        stacks,
        path: path2
      } = _ref2;
      return stacks.map((series, i) => (0, import_jsx_runtime10.jsx)("path", {
        className: (0, import_classnames10.default)("visx-area-stack", className),
        d: path2(series) || "",
        fill: color == null ? void 0 : color(series.key, i),
        ...restProps
      }, `area-stack-${i}-${series.key || ""}`));
    })
  });
}

// node_modules/@visx/shape/esm/shapes/Bar.js
var import_classnames11 = __toESM(require_classnames());
var import_jsx_runtime11 = __toESM(require_jsx_runtime());
function Bar(_ref) {
  let {
    className,
    innerRef,
    ...restProps
  } = _ref;
  return (0, import_jsx_runtime11.jsx)("rect", {
    ref: innerRef,
    className: (0, import_classnames11.default)("visx-bar", className),
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/BarRounded.js
var import_classnames12 = __toESM(require_classnames());
var import_jsx_runtime12 = __toESM(require_jsx_runtime());
function useBarRoundedPath(_ref) {
  let {
    all,
    bottom,
    bottomLeft,
    bottomRight,
    height,
    left,
    radius,
    right,
    top,
    topLeft,
    topRight,
    width,
    x,
    y
  } = _ref;
  topRight = all || top || right || topRight;
  bottomRight = all || bottom || right || bottomRight;
  bottomLeft = all || bottom || left || bottomLeft;
  topLeft = all || top || left || topLeft;
  radius = Math.max(1, Math.min(radius, Math.min(width, height) / 2));
  const diameter = 2 * radius;
  const path2 = `M${x + radius},${y} h${width - diameter}
 ${topRight ? `a${radius},${radius} 0 0 1 ${radius},${radius}` : `h${radius}v${radius}`}
 v${height - diameter}
 ${bottomRight ? `a${radius},${radius} 0 0 1 ${-radius},${radius}` : `v${radius}h${-radius}`}
 h${diameter - width}
 ${bottomLeft ? `a${radius},${radius} 0 0 1 ${-radius},${-radius}` : `h${-radius}v${-radius}`}
 v${diameter - height}
 ${topLeft ? `a${radius},${radius} 0 0 1 ${radius},${-radius}` : `v${-radius}h${radius}`}
z`.split("\n").join("");
  return path2;
}
function BarRounded(_ref2) {
  let {
    children,
    className,
    innerRef,
    x,
    y,
    width,
    height,
    radius,
    all = false,
    top = false,
    bottom = false,
    left = false,
    right = false,
    topLeft = false,
    topRight = false,
    bottomLeft = false,
    bottomRight = false,
    ...restProps
  } = _ref2;
  const path2 = useBarRoundedPath({
    x,
    y,
    width,
    height,
    radius,
    all,
    top,
    bottom,
    left,
    right,
    topLeft,
    topRight,
    bottomLeft,
    bottomRight
  });
  if (children) return (0, import_jsx_runtime12.jsx)(import_jsx_runtime12.Fragment, {
    children: children({
      path: path2
    })
  });
  return (0, import_jsx_runtime12.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames12.default)("visx-bar-rounded", className),
    d: path2,
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/BarGroup.js
var import_classnames13 = __toESM(require_classnames());

// node_modules/@visx/shape/esm/util/getBandwidth.js
function getBandwidth(scale) {
  if ("bandwidth" in scale) {
    return scale.bandwidth();
  }
  const range = scale.range();
  const domain = scale.domain();
  return Math.abs(range[range.length - 1] - range[0]) / domain.length;
}

// node_modules/@visx/shape/esm/shapes/BarGroup.js
var import_jsx_runtime13 = __toESM(require_jsx_runtime());
function BarGroup(_ref) {
  let {
    data,
    className,
    top,
    left,
    x0,
    x0Scale,
    x1Scale,
    yScale,
    color,
    keys,
    height,
    children,
    ...restProps
  } = _ref;
  const barWidth = getBandwidth(x1Scale);
  const barGroups = data.map((group, i) => ({
    index: i,
    x0: x0Scale(x0(group)),
    bars: keys.map((key, j) => {
      const value = group[key];
      return {
        index: j,
        key,
        value,
        width: barWidth,
        x: x1Scale(key) || 0,
        y: yScale(value) || 0,
        color: color(key, j),
        height: height - (yScale(value) || 0)
      };
    })
  }));
  if (children) return (0, import_jsx_runtime13.jsx)(import_jsx_runtime13.Fragment, {
    children: children(barGroups)
  });
  return (0, import_jsx_runtime13.jsx)(Group, {
    className: (0, import_classnames13.default)("visx-bar-group", className),
    top,
    left,
    children: barGroups.map((barGroup) => (0, import_jsx_runtime13.jsx)(Group, {
      left: barGroup.x0,
      children: barGroup.bars.map((bar) => (0, import_jsx_runtime13.jsx)(Bar, {
        x: bar.x,
        y: bar.y,
        width: bar.width,
        height: bar.height,
        fill: bar.color,
        ...restProps
      }, `bar-group-bar-${barGroup.index}-${bar.index}-${bar.value}-${bar.key}`))
    }, `bar-group-${barGroup.index}-${barGroup.x0}`))
  });
}

// node_modules/@visx/shape/esm/shapes/BarGroupHorizontal.js
var import_classnames14 = __toESM(require_classnames());
var import_jsx_runtime14 = __toESM(require_jsx_runtime());
function BarGroupHorizontal(_ref) {
  let {
    data,
    className,
    top,
    left,
    x = () => 0,
    y0,
    y0Scale,
    y1Scale,
    xScale,
    color,
    keys,
    width,
    children,
    ...restProps
  } = _ref;
  const barHeight = getBandwidth(y1Scale);
  const barGroups = data.map((group, i) => ({
    index: i,
    y0: y0Scale(y0(group)) || 0,
    bars: keys.map((key, j) => {
      const value = group[key];
      return {
        index: j,
        key,
        value,
        height: barHeight,
        x: x(value) || 0,
        y: y1Scale(key) || 0,
        color: color(key, j),
        width: xScale(value) || 0
      };
    })
  }));
  if (children) return (0, import_jsx_runtime14.jsx)(import_jsx_runtime14.Fragment, {
    children: children(barGroups)
  });
  return (0, import_jsx_runtime14.jsx)(Group, {
    className: (0, import_classnames14.default)("visx-bar-group-horizontal", className),
    top,
    left,
    children: barGroups.map((barGroup) => (0, import_jsx_runtime14.jsx)(Group, {
      top: barGroup.y0,
      children: barGroup.bars.map((bar) => (0, import_jsx_runtime14.jsx)(Bar, {
        x: bar.x,
        y: bar.y,
        width: bar.width,
        height: bar.height,
        fill: bar.color,
        ...restProps
      }, `bar-group-bar-${barGroup.index}-${bar.index}-${bar.value}-${bar.key}`))
    }, `bar-group-${barGroup.index}-${barGroup.y0}`))
  });
}

// node_modules/@visx/shape/esm/shapes/BarStack.js
var import_classnames15 = __toESM(require_classnames());

// node_modules/@visx/shape/esm/util/accessors.js
function getX(l) {
  return typeof (l == null ? void 0 : l.x) === "number" ? l == null ? void 0 : l.x : 0;
}
function getY(l) {
  return typeof (l == null ? void 0 : l.y) === "number" ? l == null ? void 0 : l.y : 0;
}
function getSource(l) {
  return l == null ? void 0 : l.source;
}
function getTarget(l) {
  return l == null ? void 0 : l.target;
}
function getFirstItem(d) {
  return d == null ? void 0 : d[0];
}
function getSecondItem(d) {
  return d == null ? void 0 : d[1];
}

// node_modules/@visx/shape/esm/shapes/BarStack.js
var import_jsx_runtime15 = __toESM(require_jsx_runtime());
function BarStack(_ref) {
  let {
    data,
    className,
    top,
    left,
    x,
    y0 = getFirstItem,
    y1 = getSecondItem,
    xScale,
    yScale,
    color,
    keys,
    value,
    order,
    offset,
    children,
    ...restProps
  } = _ref;
  const stack2 = stack_default();
  if (keys) stack2.keys(keys);
  if (value) setNumberOrNumberAccessor(stack2.value, value);
  if (order) stack2.order(stackOrder(order));
  if (offset) stack2.offset(stackOffset(offset));
  const stacks = stack2(data);
  const barWidth = getBandwidth(xScale);
  const barStacks = stacks.map((barStack, i) => {
    const {
      key
    } = barStack;
    return {
      index: i,
      key,
      bars: barStack.map((bar, j) => {
        const barHeight = (yScale(y0(bar)) || 0) - (yScale(y1(bar)) || 0);
        const barY = yScale(y1(bar));
        const barX = "bandwidth" in xScale ? xScale(x(bar.data)) : Math.max((xScale(x(bar.data)) || 0) - barWidth / 2);
        return {
          bar,
          key,
          index: j,
          height: barHeight,
          width: barWidth,
          x: barX || 0,
          y: barY || 0,
          color: color(barStack.key, j)
        };
      })
    };
  });
  if (children) return (0, import_jsx_runtime15.jsx)(import_jsx_runtime15.Fragment, {
    children: children(barStacks)
  });
  return (0, import_jsx_runtime15.jsx)(Group, {
    className: (0, import_classnames15.default)("visx-bar-stack", className),
    top,
    left,
    children: barStacks.map((barStack) => barStack.bars.map((bar) => (0, import_jsx_runtime15.jsx)(Bar, {
      x: bar.x,
      y: bar.y,
      height: bar.height,
      width: bar.width,
      fill: bar.color,
      ...restProps
    }, `bar-stack-${barStack.index}-${bar.index}`)))
  });
}

// node_modules/@visx/shape/esm/shapes/BarStackHorizontal.js
var import_classnames16 = __toESM(require_classnames());
var import_jsx_runtime16 = __toESM(require_jsx_runtime());
function BarStackHorizontal(_ref) {
  let {
    data,
    className,
    top,
    left,
    y,
    x0 = getFirstItem,
    x1 = getSecondItem,
    xScale,
    yScale,
    color,
    keys,
    value,
    order,
    offset,
    children,
    ...restProps
  } = _ref;
  const stack2 = stack_default();
  if (keys) stack2.keys(keys);
  if (value) setNumberOrNumberAccessor(stack2.value, value);
  if (order) stack2.order(stackOrder(order));
  if (offset) stack2.offset(stackOffset(offset));
  const stacks = stack2(data);
  const barHeight = getBandwidth(yScale);
  const barStacks = stacks.map((barStack, i) => {
    const {
      key
    } = barStack;
    return {
      index: i,
      key,
      bars: barStack.map((bar, j) => {
        const barWidth = (xScale(x1(bar)) || 0) - (xScale(x0(bar)) || 0);
        const barX = xScale(x0(bar));
        const barY = "bandwidth" in yScale ? yScale(y(bar.data)) : Math.max((yScale(y(bar.data)) || 0) - barWidth / 2);
        return {
          bar,
          key,
          index: j,
          height: barHeight,
          width: barWidth,
          x: barX || 0,
          y: barY || 0,
          color: color(barStack.key, j)
        };
      })
    };
  });
  if (children) return (0, import_jsx_runtime16.jsx)(import_jsx_runtime16.Fragment, {
    children: children(barStacks)
  });
  return (0, import_jsx_runtime16.jsx)(Group, {
    className: (0, import_classnames16.default)("visx-bar-stack-horizontal", className),
    top,
    left,
    children: barStacks.map((barStack) => barStack.bars.map((bar) => (0, import_jsx_runtime16.jsx)(Bar, {
      x: bar.x,
      y: bar.y,
      height: bar.height,
      width: bar.width,
      fill: bar.color,
      ...restProps
    }, `bar-stack-${barStack.index}-${bar.index}`)))
  });
}

// node_modules/@visx/shape/esm/util/trigonometry.js
var degreesToRadians = (degrees) => Math.PI / 180 * degrees;

// node_modules/@visx/shape/esm/shapes/link/diagonal/LinkHorizontal.js
var import_classnames17 = __toESM(require_classnames());
var import_jsx_runtime17 = __toESM(require_jsx_runtime());
function pathHorizontalDiagonal(_ref) {
  let {
    source,
    target,
    x,
    y
  } = _ref;
  return (data) => {
    const link = linkHorizontal();
    link.x(x);
    link.y(y);
    link.source(source);
    link.target(target);
    return link(data);
  };
}
function LinkHorizontalDiagonal(_ref2) {
  let {
    className,
    children,
    data,
    innerRef,
    path: path2,
    x = getY,
    // note this returns a y value
    y = getX,
    // note this returns an x value
    source = getSource,
    target = getTarget,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathHorizontalDiagonal({
    source,
    target,
    x,
    y
  });
  if (children) return (0, import_jsx_runtime17.jsx)(import_jsx_runtime17.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime17.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames17.default)("visx-link visx-link-horizontal-diagonal", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/diagonal/LinkVertical.js
var import_classnames18 = __toESM(require_classnames());
var import_jsx_runtime18 = __toESM(require_jsx_runtime());
function pathVerticalDiagonal(_ref) {
  let {
    source,
    target,
    x,
    y
  } = _ref;
  return (data) => {
    const link = linkVertical();
    link.x(x);
    link.y(y);
    link.source(source);
    link.target(target);
    return link(data);
  };
}
function LinkVerticalDiagonal(_ref2) {
  let {
    className,
    children,
    data,
    innerRef,
    path: path2,
    x = getX,
    y = getY,
    source = getSource,
    target = getTarget,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathVerticalDiagonal({
    source,
    target,
    x,
    y
  });
  if (children) return (0, import_jsx_runtime18.jsx)(import_jsx_runtime18.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime18.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames18.default)("visx-link visx-link-vertical-diagonal", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/diagonal/LinkRadial.js
var import_classnames19 = __toESM(require_classnames());
var import_jsx_runtime19 = __toESM(require_jsx_runtime());
function pathRadialDiagonal(_ref) {
  let {
    source,
    target,
    angle,
    radius
  } = _ref;
  return (data) => {
    const link = linkRadial();
    link.angle(angle);
    link.radius(radius);
    link.source(source);
    link.target(target);
    return link(data);
  };
}
function LinkRadialDiagonal(_ref2) {
  let {
    className,
    children,
    data,
    innerRef,
    path: path2,
    angle = getX,
    radius = getY,
    source = getSource,
    target = getTarget,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathRadialDiagonal({
    source,
    target,
    angle,
    radius
  });
  if (children) return (0, import_jsx_runtime19.jsx)(import_jsx_runtime19.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime19.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames19.default)("visx-link visx-link-radial-diagonal", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/curve/LinkHorizontalCurve.js
var import_classnames20 = __toESM(require_classnames());
var import_jsx_runtime20 = __toESM(require_jsx_runtime());
function pathHorizontalCurve(_ref) {
  let {
    source,
    target,
    x,
    y,
    percent
  } = _ref;
  return (link) => {
    const sourceData = source(link);
    const targetData = target(link);
    const sx = x(sourceData);
    const sy = y(sourceData);
    const tx = x(targetData);
    const ty = y(targetData);
    const dx = tx - sx;
    const dy = ty - sy;
    const ix = percent * (dx + dy);
    const iy = percent * (dy - dx);
    const path2 = path();
    path2.moveTo(sx, sy);
    path2.bezierCurveTo(sx + ix, sy + iy, tx + iy, ty - ix, tx, ty);
    return path2.toString();
  };
}
function LinkHorizontalCurve(_ref2) {
  let {
    className,
    children,
    data,
    innerRef,
    path: path2,
    percent = 0.2,
    x = getY,
    // note this returns a y value
    y = getX,
    // note this returns an x value
    source = getSource,
    target = getTarget,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathHorizontalCurve({
    source,
    target,
    x,
    y,
    percent
  });
  if (children) return (0, import_jsx_runtime20.jsx)(import_jsx_runtime20.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime20.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames20.default)("visx-link visx-link-horizontal-curve", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/curve/LinkVerticalCurve.js
var import_classnames21 = __toESM(require_classnames());
var import_jsx_runtime21 = __toESM(require_jsx_runtime());
function pathVerticalCurve(_ref) {
  let {
    source,
    target,
    x,
    y,
    percent
  } = _ref;
  return (link) => {
    const sourceData = source(link);
    const targetData = target(link);
    const sx = x(sourceData);
    const sy = y(sourceData);
    const tx = x(targetData);
    const ty = y(targetData);
    const dx = tx - sx;
    const dy = ty - sy;
    const ix = percent * (dx + dy);
    const iy = percent * (dy - dx);
    const path2 = path();
    path2.moveTo(sx, sy);
    path2.bezierCurveTo(sx + ix, sy + iy, tx + iy, ty - ix, tx, ty);
    return path2.toString();
  };
}
function LinkVerticalCurve(_ref2) {
  let {
    className,
    children,
    data,
    innerRef,
    path: path2,
    percent = 0.2,
    x = getX,
    y = getY,
    source = getSource,
    target = getTarget,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathVerticalCurve({
    source,
    target,
    x,
    y,
    percent
  });
  if (children) return (0, import_jsx_runtime21.jsx)(import_jsx_runtime21.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime21.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames21.default)("visx-link visx-link-vertical-curve", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/curve/LinkRadialCurve.js
var import_classnames22 = __toESM(require_classnames());
var import_jsx_runtime22 = __toESM(require_jsx_runtime());
function pathRadialCurve(_ref) {
  let {
    source,
    target,
    x,
    y,
    percent
  } = _ref;
  return (link) => {
    const sourceData = source(link);
    const targetData = target(link);
    const sa = x(sourceData) - Math.PI / 2;
    const sr = y(sourceData);
    const ta = x(targetData) - Math.PI / 2;
    const tr = y(targetData);
    const sc = Math.cos(sa);
    const ss = Math.sin(sa);
    const tc = Math.cos(ta);
    const ts = Math.sin(ta);
    const sx = sr * sc;
    const sy = sr * ss;
    const tx = tr * tc;
    const ty = tr * ts;
    const dx = tx - sx;
    const dy = ty - sy;
    const ix = percent * (dx + dy);
    const iy = percent * (dy - dx);
    const path2 = path();
    path2.moveTo(sx, sy);
    path2.bezierCurveTo(sx + ix, sy + iy, tx + iy, ty - ix, tx, ty);
    return path2.toString();
  };
}
function LinkRadialCurve(_ref2) {
  let {
    className,
    children,
    data,
    innerRef,
    path: path2,
    percent = 0.2,
    x = getX,
    y = getY,
    source = getSource,
    target = getTarget,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathRadialCurve({
    source,
    target,
    x,
    y,
    percent
  });
  if (children) return (0, import_jsx_runtime22.jsx)(import_jsx_runtime22.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime22.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames22.default)("visx-link visx-link-radial-curve", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/line/LinkHorizontalLine.js
var import_classnames23 = __toESM(require_classnames());
var import_jsx_runtime23 = __toESM(require_jsx_runtime());
function pathHorizontalLine(_ref) {
  let {
    source,
    target,
    x,
    y
  } = _ref;
  return (data) => {
    const sourceData = source(data);
    const targetData = target(data);
    const sx = x(sourceData);
    const sy = y(sourceData);
    const tx = x(targetData);
    const ty = y(targetData);
    const path2 = path();
    path2.moveTo(sx, sy);
    path2.lineTo(tx, ty);
    return path2.toString();
  };
}
function LinkHorizontalLine(_ref2) {
  let {
    className,
    children,
    innerRef,
    data,
    path: path2,
    x = getY,
    // note this returns a y value
    y = getX,
    // note this returns a x value
    source = getSource,
    target = getTarget,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathHorizontalLine({
    source,
    target,
    x,
    y
  });
  if (children) return (0, import_jsx_runtime23.jsx)(import_jsx_runtime23.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime23.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames23.default)("visx-link visx-link-horizontal-line", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/line/LinkVerticalLine.js
var import_classnames24 = __toESM(require_classnames());
var import_jsx_runtime24 = __toESM(require_jsx_runtime());
function pathVerticalLine(_ref) {
  let {
    source,
    target,
    x,
    y
  } = _ref;
  return (data) => {
    const sourceData = source(data);
    const targetData = target(data);
    const sx = x(sourceData);
    const sy = y(sourceData);
    const tx = x(targetData);
    const ty = y(targetData);
    const path2 = path();
    path2.moveTo(sx, sy);
    path2.lineTo(tx, ty);
    return path2.toString();
  };
}
function LinkVerticalLine(_ref2) {
  let {
    className,
    innerRef,
    data,
    path: path2,
    x = getX,
    y = getY,
    source = getSource,
    target = getTarget,
    children,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathVerticalLine({
    source,
    target,
    x,
    y
  });
  if (children) return (0, import_jsx_runtime24.jsx)(import_jsx_runtime24.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime24.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames24.default)("visx-link visx-link-vertical-line", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/line/LinkRadialLine.js
var import_classnames25 = __toESM(require_classnames());
var import_jsx_runtime25 = __toESM(require_jsx_runtime());
function pathRadialLine(_ref) {
  let {
    source,
    target,
    x,
    y
  } = _ref;
  return (data) => {
    const sourceData = source(data);
    const targetData = target(data);
    const sa = x(sourceData) - Math.PI / 2;
    const sr = y(sourceData);
    const ta = x(targetData) - Math.PI / 2;
    const tr = y(targetData);
    const sc = Math.cos(sa);
    const ss = Math.sin(sa);
    const tc = Math.cos(ta);
    const ts = Math.sin(ta);
    const path2 = path();
    path2.moveTo(sr * sc, sr * ss);
    path2.lineTo(tr * tc, tr * ts);
    return path2.toString();
  };
}
function LinkRadialLine(_ref2) {
  let {
    className,
    innerRef,
    data,
    path: path2,
    x = getX,
    y = getY,
    source = getSource,
    target = getTarget,
    children,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathRadialLine({
    source,
    target,
    x,
    y
  });
  if (children) return (0, import_jsx_runtime25.jsx)(import_jsx_runtime25.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime25.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames25.default)("visx-link visx-link-radial-line", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/step/LinkHorizontalStep.js
var import_classnames26 = __toESM(require_classnames());
var import_jsx_runtime26 = __toESM(require_jsx_runtime());
function pathHorizontalStep(_ref) {
  let {
    source,
    target,
    x,
    y,
    percent
  } = _ref;
  return (link) => {
    const sourceData = source(link);
    const targetData = target(link);
    const sx = x(sourceData);
    const sy = y(sourceData);
    const tx = x(targetData);
    const ty = y(targetData);
    const path2 = path();
    path2.moveTo(sx, sy);
    path2.lineTo(sx + (tx - sx) * percent, sy);
    path2.lineTo(sx + (tx - sx) * percent, ty);
    path2.lineTo(tx, ty);
    return path2.toString();
  };
}
function LinkHorizontalStep(_ref2) {
  let {
    className,
    innerRef,
    data,
    path: path2,
    percent = 0.5,
    x = getY,
    // note this returns a y value
    y = getX,
    // note this returns a x value
    source = getSource,
    target = getTarget,
    children,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathHorizontalStep({
    source,
    target,
    x,
    y,
    percent
  });
  if (children) return (0, import_jsx_runtime26.jsx)(import_jsx_runtime26.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime26.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames26.default)("visx-link visx-link-horizontal-step", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/step/LinkVerticalStep.js
var import_classnames27 = __toESM(require_classnames());
var import_jsx_runtime27 = __toESM(require_jsx_runtime());
function pathVerticalStep(_ref) {
  let {
    source,
    target,
    x,
    y,
    percent
  } = _ref;
  return (link) => {
    const sourceData = source(link);
    const targetData = target(link);
    const sx = x(sourceData);
    const sy = y(sourceData);
    const tx = x(targetData);
    const ty = y(targetData);
    const path2 = path();
    path2.moveTo(sx, sy);
    path2.lineTo(sx, sy + (ty - sy) * percent);
    path2.lineTo(tx, sy + (ty - sy) * percent);
    path2.lineTo(tx, ty);
    return path2.toString();
  };
}
function LinkVerticalStep(_ref2) {
  let {
    className,
    innerRef,
    data,
    path: path2,
    percent = 0.5,
    x = getX,
    y = getY,
    source = getSource,
    target = getTarget,
    children,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathVerticalStep({
    source,
    target,
    x,
    y,
    percent
  });
  if (children) return (0, import_jsx_runtime27.jsx)(import_jsx_runtime27.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime27.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames27.default)("visx-link visx-link-vertical-step", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/link/step/LinkRadialStep.js
var import_classnames28 = __toESM(require_classnames());
var import_jsx_runtime28 = __toESM(require_jsx_runtime());
function pathRadialStep(_ref) {
  let {
    source,
    target,
    x,
    y
  } = _ref;
  return (link) => {
    const sourceData = source(link);
    const targetData = target(link);
    const sx = x(sourceData);
    const sy = y(sourceData);
    const tx = x(targetData);
    const ty = y(targetData);
    const sa = sx - Math.PI / 2;
    const sr = sy;
    const ta = tx - Math.PI / 2;
    const tr = ty;
    const sc = Math.cos(sa);
    const ss = Math.sin(sa);
    const tc = Math.cos(ta);
    const ts = Math.sin(ta);
    const sf = Math.abs(ta - sa) > Math.PI ? ta <= sa : ta > sa;
    return `
      M${sr * sc},${sr * ss}
      A${sr},${sr},0,0,${sf ? 1 : 0},${sr * tc},${sr * ts}
      L${tr * tc},${tr * ts}
    `;
  };
}
function LinkRadialStep(_ref2) {
  let {
    className,
    innerRef,
    data,
    path: path2,
    x = getX,
    y = getY,
    source = getSource,
    target = getTarget,
    children,
    ...restProps
  } = _ref2;
  const pathGen = path2 || pathRadialStep({
    source,
    target,
    x,
    y
  });
  if (children) return (0, import_jsx_runtime28.jsx)(import_jsx_runtime28.Fragment, {
    children: children({
      path: pathGen
    })
  });
  return (0, import_jsx_runtime28.jsx)("path", {
    ref: innerRef,
    className: (0, import_classnames28.default)("visx-link visx-link-radial-step", className),
    d: pathGen(data) || "",
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/Polygon.js
var import_classnames29 = __toESM(require_classnames());
var import_jsx_runtime29 = __toESM(require_jsx_runtime());
var DEFAULT_CENTER = {
  x: 0,
  y: 0
};
var getPoint = (_ref) => {
  let {
    sides = 4,
    size = 25,
    center = DEFAULT_CENTER,
    rotate = 0,
    side
  } = _ref;
  const degrees = 360 / sides * side - rotate;
  const radians = degreesToRadians(degrees);
  return {
    x: center.x + size * Math.cos(radians),
    y: center.y + size * Math.sin(radians)
  };
};
var getPoints = (_ref2) => {
  let {
    sides,
    size,
    center,
    rotate
  } = _ref2;
  return new Array(sides).fill(0).map((_, side) => getPoint({
    sides,
    size,
    center,
    rotate,
    side
  }));
};
function Polygon(_ref3) {
  let {
    sides = 4,
    size = 25,
    center = DEFAULT_CENTER,
    rotate = 0,
    className,
    children,
    innerRef,
    points,
    ...restProps
  } = _ref3;
  const pointsToRender = points || getPoints({
    sides,
    size,
    center,
    rotate
  }).map((_ref4) => {
    let {
      x,
      y
    } = _ref4;
    return [x, y];
  });
  if (children) return (0, import_jsx_runtime29.jsx)(import_jsx_runtime29.Fragment, {
    children: children({
      points: pointsToRender
    })
  });
  return (0, import_jsx_runtime29.jsx)("polygon", {
    ref: innerRef,
    className: (0, import_classnames29.default)("visx-polygon", className),
    points: pointsToRender.join(" "),
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/Circle.js
var import_classnames30 = __toESM(require_classnames());
var import_jsx_runtime30 = __toESM(require_jsx_runtime());
function Circle(_ref) {
  let {
    className,
    innerRef,
    ...restProps
  } = _ref;
  return (0, import_jsx_runtime30.jsx)("circle", {
    ref: innerRef,
    className: (0, import_classnames30.default)("visx-circle", className),
    ...restProps
  });
}

// node_modules/@visx/shape/esm/shapes/SplitLinePath.js
var import_react = __toESM(require_react());

// node_modules/@visx/shape/esm/util/getOrCreateMeasurementElement.js
var SVG_NAMESPACE_URL = "http://www.w3.org/2000/svg";
function getOrCreateMeasurementElement(elementId) {
  let pathElement = document.getElementById(elementId);
  if (!pathElement) {
    const svg = document.createElementNS(SVG_NAMESPACE_URL, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.style.opacity = "0";
    svg.style.width = "0";
    svg.style.height = "0";
    svg.style.position = "absolute";
    svg.style.top = "-100%";
    svg.style.left = "-100%";
    svg.style.pointerEvents = "none";
    pathElement = document.createElementNS(SVG_NAMESPACE_URL, "path");
    pathElement.setAttribute("id", elementId);
    svg.appendChild(pathElement);
    document.body.appendChild(svg);
  }
  return pathElement;
}

// node_modules/@visx/shape/esm/util/getSplitLineSegments.js
var MEASUREMENT_ELEMENT_ID = "__visx_splitpath_svg_path_measurement_id";
var TRUE = () => true;
function getSplitLineSegments(_ref) {
  let {
    path: path2,
    pointsInSegments,
    segmentation = "x",
    sampleRate = 1
  } = _ref;
  try {
    const pathElement = getOrCreateMeasurementElement(MEASUREMENT_ELEMENT_ID);
    pathElement.setAttribute("d", path2);
    const totalLength = pathElement.getTotalLength();
    const numSegments = pointsInSegments.length;
    const lineSegments = pointsInSegments.map(() => []);
    if (segmentation === "x" || segmentation === "y") {
      const segmentStarts = pointsInSegments.map((points) => {
        var _a;
        return (_a = points.find((p) => typeof p[segmentation] === "number")) == null ? void 0 : _a[segmentation];
      });
      const first = pathElement.getPointAtLength(0);
      const last = pathElement.getPointAtLength(totalLength);
      const isIncreasing = last[segmentation] > first[segmentation];
      const isBeyondSegmentStart = isIncreasing ? segmentStarts.map((start) => typeof start === "undefined" ? TRUE : (xOrY) => xOrY >= start) : segmentStarts.map((start) => typeof start === "undefined" ? TRUE : (xOrY) => xOrY <= start);
      let currentSegment = 0;
      for (let distance = 0; distance <= totalLength; distance += sampleRate) {
        const sample = pathElement.getPointAtLength(distance);
        const position = sample[segmentation];
        while (currentSegment < numSegments - 1 && isBeyondSegmentStart[currentSegment + 1](position)) {
          currentSegment += 1;
        }
        lineSegments[currentSegment].push(sample);
      }
    } else {
      const numPointsInSegment = pointsInSegments.map((points) => points.length);
      const numPoints = numPointsInSegment.reduce((sum, curr) => sum + curr, 0);
      const lengthBetweenPoints = totalLength / Math.max(1, numPoints - 1);
      const segmentStarts = numPointsInSegment.slice(0, numSegments - 1);
      segmentStarts.unshift(0);
      for (let i = 2; i < numSegments; i += 1) {
        segmentStarts[i] += segmentStarts[i - 1];
      }
      for (let i = 0; i < numSegments; i += 1) {
        segmentStarts[i] *= lengthBetweenPoints;
      }
      let currentSegment = 0;
      for (let distance = 0; distance <= totalLength; distance += sampleRate) {
        const sample = pathElement.getPointAtLength(distance);
        while (currentSegment < numSegments - 1 && distance >= segmentStarts[currentSegment + 1]) {
          currentSegment += 1;
        }
        lineSegments[currentSegment].push(sample);
      }
    }
    return lineSegments;
  } catch (e) {
    console.warn(e);
    return [];
  }
}

// node_modules/@visx/shape/esm/shapes/SplitLinePath.js
var import_jsx_runtime31 = __toESM(require_jsx_runtime());
var getX2 = (d) => d.x || 0;
var getY2 = (d) => d.y || 0;
function SplitLinePath(_ref) {
  let {
    children,
    className,
    curve,
    defined,
    segmentation,
    sampleRate,
    segments,
    x,
    y,
    styles
  } = _ref;
  const pointsInSegments = (0, import_react.useMemo)(() => {
    const xFn = typeof x === "number" || typeof x === "undefined" ? () => x : x;
    const yFn = typeof y === "number" || typeof y === "undefined" ? () => y : y;
    return segments.map((s) => s.map((value, i) => ({
      x: xFn(value, i, s),
      y: yFn(value, i, s)
    })));
  }, [x, y, segments]);
  const pathString = (0, import_react.useMemo)(() => {
    const path2 = line({
      x,
      y,
      defined,
      curve
    });
    return path2(segments.flat()) || "";
  }, [x, y, defined, curve, segments]);
  const splitLineSegments = (0, import_react.useMemo)(() => getSplitLineSegments({
    path: pathString,
    segmentation,
    pointsInSegments,
    sampleRate
  }), [pathString, segmentation, pointsInSegments, sampleRate]);
  return (0, import_jsx_runtime31.jsx)("g", {
    children: splitLineSegments.map((segment, index) => children ? (0, import_jsx_runtime31.jsx)(import_react.Fragment, {
      children: children({
        index,
        segment,
        styles: styles[index] || styles[index % styles.length]
      })
    }, index) : (0, import_jsx_runtime31.jsx)(LinePath, {
      className,
      data: segment,
      x: getX2,
      y: getY2,
      ...styles[index] || styles[index % styles.length]
    }, index))
  });
}

export {
  require_classnames,
  STACK_ORDERS,
  STACK_ORDER_NAMES,
  stackOrder,
  STACK_OFFSETS,
  STACK_OFFSET_NAMES,
  stackOffset,
  arc,
  area,
  line,
  pie,
  radialLine,
  stack,
  Arc,
  Group,
  Pie,
  Line,
  LinePath,
  LineRadial,
  Area,
  AreaClosed,
  Stack,
  AreaStack,
  Bar,
  BarRounded,
  getBandwidth,
  BarGroup,
  BarGroupHorizontal,
  getX,
  getY,
  getSource,
  getTarget,
  getFirstItem,
  getSecondItem,
  BarStack,
  BarStackHorizontal,
  degreesToRadians,
  pathHorizontalDiagonal,
  LinkHorizontalDiagonal,
  pathVerticalDiagonal,
  LinkVerticalDiagonal,
  pathRadialDiagonal,
  LinkRadialDiagonal,
  pathHorizontalCurve,
  LinkHorizontalCurve,
  pathVerticalCurve,
  LinkVerticalCurve,
  pathRadialCurve,
  LinkRadialCurve,
  pathHorizontalLine,
  LinkHorizontalLine,
  pathVerticalLine,
  LinkVerticalLine,
  pathRadialLine,
  LinkRadialLine,
  pathHorizontalStep,
  LinkHorizontalStep,
  pathVerticalStep,
  LinkVerticalStep,
  pathRadialStep,
  LinkRadialStep,
  getPoint,
  getPoints,
  Polygon,
  Circle,
  SplitLinePath
};
/*! Bundled license information:

classnames/index.js:
  (*!
  	Copyright (c) 2018 Jed Watson.
  	Licensed under the MIT License (MIT), see
  	http://jedwatson.github.io/classnames
  *)
*/
//# sourceMappingURL=chunk-J7BS2OSU.js.map
