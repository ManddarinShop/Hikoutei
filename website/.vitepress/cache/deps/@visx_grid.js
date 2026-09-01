import {
  Arc,
  Group,
  Line,
  require_classnames
} from "./chunk-J7BS2OSU.js";
import {
  require_jsx_runtime
} from "./chunk-JNOOTWYN.js";
import "./chunk-CVCTGI67.js";
import "./chunk-UHWCQHRD.js";
import "./chunk-X6Z6NCW2.js";
import {
  Point
} from "./chunk-PXWL2EMG.js";
import {
  coerceNumber,
  getTicks
} from "./chunk-JMBNEEIE.js";
import "./chunk-I4SLUZSC.js";
import {
  __toESM
} from "./chunk-DC5AMYBS.js";

// node_modules/@visx/grid/esm/grids/GridRows.js
var import_classnames = __toESM(require_classnames());

// node_modules/@visx/grid/esm/utils/getScaleBandwidth.js
function getScaleBandwidth(scale) {
  return "bandwidth" in scale ? scale.bandwidth() : 0;
}

// node_modules/@visx/grid/esm/grids/GridRows.js
var import_jsx_runtime = __toESM(require_jsx_runtime());
function GridRows(_ref) {
  let {
    top = 0,
    left = 0,
    scale,
    width,
    stroke = "#eaf0f6",
    strokeWidth = 1,
    strokeDasharray,
    className,
    children,
    numTicks = 10,
    lineStyle,
    offset,
    tickValues,
    ...restProps
  } = _ref;
  const ticks = tickValues ?? getTicks(scale, numTicks);
  const scaleOffset = (offset ?? 0) + getScaleBandwidth(scale) / 2;
  const tickLines = ticks.map((d, index) => {
    const y = (coerceNumber(scale(d)) ?? 0) + scaleOffset;
    return {
      index,
      from: new Point({
        x: 0,
        y
      }),
      to: new Point({
        x: width,
        y
      })
    };
  });
  return (0, import_jsx_runtime.jsx)(Group, {
    className: (0, import_classnames.default)("visx-rows", className),
    top,
    left,
    children: children ? children({
      lines: tickLines
    }) : tickLines.map((_ref2) => {
      let {
        from,
        to,
        index
      } = _ref2;
      return (0, import_jsx_runtime.jsx)(Line, {
        from,
        to,
        stroke,
        strokeWidth,
        strokeDasharray,
        style: lineStyle,
        ...restProps
      }, `row-line-${index}`);
    })
  });
}

// node_modules/@visx/grid/esm/grids/GridColumns.js
var import_classnames2 = __toESM(require_classnames());
var import_jsx_runtime2 = __toESM(require_jsx_runtime());
function GridColumns(_ref) {
  let {
    top = 0,
    left = 0,
    scale,
    height,
    stroke = "#eaf0f6",
    strokeWidth = 1,
    strokeDasharray,
    className,
    numTicks = 10,
    lineStyle,
    offset,
    tickValues,
    children,
    ...restProps
  } = _ref;
  const ticks = tickValues ?? getTicks(scale, numTicks);
  const scaleOffset = (offset ?? 0) + getScaleBandwidth(scale) / 2;
  const tickLines = ticks.map((d, index) => {
    const x = (coerceNumber(scale(d)) ?? 0) + scaleOffset;
    return {
      index,
      from: new Point({
        x,
        y: 0
      }),
      to: new Point({
        x,
        y: height
      })
    };
  });
  return (0, import_jsx_runtime2.jsx)(Group, {
    className: (0, import_classnames2.default)("visx-columns", className),
    top,
    left,
    children: children ? children({
      lines: tickLines
    }) : tickLines.map((_ref2) => {
      let {
        from,
        to,
        index
      } = _ref2;
      return (0, import_jsx_runtime2.jsx)(Line, {
        from,
        to,
        stroke,
        strokeWidth,
        strokeDasharray,
        style: lineStyle,
        ...restProps
      }, `column-line-${index}`);
    })
  });
}

// node_modules/@visx/grid/esm/grids/Grid.js
var import_classnames3 = __toESM(require_classnames());
var import_jsx_runtime3 = __toESM(require_jsx_runtime());
function Grid(_ref) {
  let {
    top,
    left,
    xScale,
    yScale,
    width,
    height,
    className,
    stroke,
    strokeWidth,
    strokeDasharray,
    numTicksRows,
    numTicksColumns,
    rowLineStyle,
    columnLineStyle,
    xOffset,
    yOffset,
    rowTickValues,
    columnTickValues,
    ...restProps
  } = _ref;
  return (0, import_jsx_runtime3.jsxs)(Group, {
    className: (0, import_classnames3.default)("visx-grid", className),
    top,
    left,
    children: [(0, import_jsx_runtime3.jsx)(GridRows, {
      className,
      scale: yScale,
      width,
      stroke,
      strokeWidth,
      strokeDasharray,
      numTicks: numTicksRows,
      lineStyle: rowLineStyle,
      offset: yOffset,
      tickValues: rowTickValues,
      ...restProps
    }), (0, import_jsx_runtime3.jsx)(GridColumns, {
      className,
      scale: xScale,
      height,
      stroke,
      strokeWidth,
      strokeDasharray,
      numTicks: numTicksColumns,
      lineStyle: columnLineStyle,
      offset: xOffset,
      tickValues: columnTickValues,
      ...restProps
    })]
  });
}

// node_modules/@visx/grid/esm/grids/GridAngle.js
var import_classnames4 = __toESM(require_classnames());

// node_modules/@visx/grid/esm/utils/polarToCartesian.js
function polarToCartesian(_ref) {
  let {
    radius,
    angle
  } = _ref;
  return {
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle)
  };
}

// node_modules/@visx/grid/esm/grids/GridAngle.js
var import_jsx_runtime4 = __toESM(require_jsx_runtime());
function GridAngle(_ref) {
  let {
    className,
    innerRadius = 0,
    left = 0,
    lineClassName,
    lineStyle,
    numTicks = 10,
    outerRadius = 0,
    scale,
    stroke = "#eaf0f6",
    strokeDasharray,
    strokeWidth = 1,
    tickValues,
    top = 0,
    children,
    // Explicitly extract children so it doesn't get spread to Line
    ...restProps
  } = _ref;
  const ticks = tickValues ?? getTicks(scale, numTicks);
  return (0, import_jsx_runtime4.jsx)(Group, {
    className: (0, import_classnames4.default)("visx-grid-angle", className),
    top,
    left,
    children: ticks.map((tick, i) => {
      const angle = (coerceNumber(scale(tick)) ?? Math.PI / 2) - Math.PI / 2;
      return (0, import_jsx_runtime4.jsx)(Line, {
        className: lineClassName,
        from: new Point(polarToCartesian({
          angle,
          radius: innerRadius
        })),
        to: new Point(polarToCartesian({
          angle,
          radius: outerRadius
        })),
        stroke,
        strokeWidth,
        strokeDasharray,
        style: lineStyle,
        ...restProps
      }, `polar-grid-${tick}-${i}`);
    })
  });
}

// node_modules/@visx/grid/esm/grids/GridRadial.js
var import_classnames5 = __toESM(require_classnames());
var import_jsx_runtime5 = __toESM(require_jsx_runtime());
function GridRadial(_ref) {
  let {
    arcThickness,
    className,
    endAngle = 2 * Math.PI,
    fill = "transparent",
    fillOpacity = 1,
    left = 0,
    lineClassName,
    lineStyle,
    numTicks = 10,
    scale,
    startAngle = 0,
    stroke = "#eaf0f6",
    strokeWidth = 1,
    strokeDasharray,
    tickValues,
    top = 0,
    ...restProps
  } = _ref;
  const radii = tickValues ?? getTicks(scale, numTicks);
  const innerRadius = Math.min(...scale.domain());
  return (0, import_jsx_runtime5.jsx)(Group, {
    className: (0, import_classnames5.default)("visx-grid-radial", className),
    top,
    left,
    children: radii.map((radius, i) => (0, import_jsx_runtime5.jsx)(Arc, {
      className: lineClassName,
      startAngle,
      endAngle,
      innerRadius: scale(arcThickness ? radius - arcThickness : innerRadius),
      outerRadius: scale(radius),
      fill,
      fillOpacity,
      stroke,
      strokeWidth,
      strokeDasharray,
      style: lineStyle,
      ...restProps
    }, `radial-grid-${radius}-${i}`))
  });
}

// node_modules/@visx/grid/esm/grids/GridPolar.js
var import_classnames6 = __toESM(require_classnames());
var import_jsx_runtime6 = __toESM(require_jsx_runtime());
function GridPolar(_ref) {
  let {
    arcThickness,
    className,
    classNameAngle,
    classNameRadial,
    endAngle,
    fillRadial,
    innerRadius,
    left,
    lineClassNameAngle,
    lineClassNameRadial,
    lineStyleAngle,
    lineStyleRadial,
    numTicksAngle,
    numTicksRadial,
    outerRadius,
    scaleAngle,
    scaleRadial,
    startAngle,
    strokeAngle,
    strokeRadial,
    strokeWidthAngle,
    strokeWidthRadial,
    strokeDasharrayAngle,
    strokeDasharrayRadial,
    tickValuesAngle,
    tickValuesRadial,
    top
  } = _ref;
  return (0, import_jsx_runtime6.jsxs)(Group, {
    className: (0, import_classnames6.default)("visx-grid-polar", className),
    top,
    left,
    children: [(0, import_jsx_runtime6.jsx)(GridAngle, {
      className: classNameAngle,
      innerRadius,
      lineClassName: lineClassNameAngle,
      lineStyle: lineStyleAngle,
      numTicks: numTicksAngle,
      outerRadius,
      scale: scaleAngle,
      stroke: strokeAngle,
      strokeWidth: strokeWidthAngle,
      strokeDasharray: strokeDasharrayAngle,
      tickValues: tickValuesAngle
    }), (0, import_jsx_runtime6.jsx)(GridRadial, {
      arcThickness,
      className: classNameRadial,
      endAngle,
      fill: fillRadial,
      lineClassName: lineClassNameRadial,
      lineStyle: lineStyleRadial,
      numTicks: numTicksRadial,
      scale: scaleRadial,
      startAngle,
      stroke: strokeRadial,
      strokeWidth: strokeWidthRadial,
      strokeDasharray: strokeDasharrayRadial,
      tickValues: tickValuesRadial
    })]
  });
}
export {
  Grid,
  GridAngle,
  GridColumns,
  GridPolar,
  GridRadial,
  GridRows
};
//# sourceMappingURL=@visx_grid.js.map
