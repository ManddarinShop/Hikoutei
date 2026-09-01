import {
  require_jsx_runtime
} from "./chunk-JNOOTWYN.js";
import {
  require_react
} from "./chunk-CVCTGI67.js";
import {
  __commonJS,
  __publicField,
  __toESM
} from "./chunk-DC5AMYBS.js";

// node_modules/lodash/isObject.js
var require_isObject = __commonJS({
  "node_modules/lodash/isObject.js"(exports, module) {
    function isObject(value) {
      var type = typeof value;
      return value != null && (type == "object" || type == "function");
    }
    module.exports = isObject;
  }
});

// node_modules/lodash/_freeGlobal.js
var require_freeGlobal = __commonJS({
  "node_modules/lodash/_freeGlobal.js"(exports, module) {
    var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
    module.exports = freeGlobal;
  }
});

// node_modules/lodash/_root.js
var require_root = __commonJS({
  "node_modules/lodash/_root.js"(exports, module) {
    var freeGlobal = require_freeGlobal();
    var freeSelf = typeof self == "object" && self && self.Object === Object && self;
    var root = freeGlobal || freeSelf || Function("return this")();
    module.exports = root;
  }
});

// node_modules/lodash/now.js
var require_now = __commonJS({
  "node_modules/lodash/now.js"(exports, module) {
    var root = require_root();
    var now = function() {
      return root.Date.now();
    };
    module.exports = now;
  }
});

// node_modules/lodash/_trimmedEndIndex.js
var require_trimmedEndIndex = __commonJS({
  "node_modules/lodash/_trimmedEndIndex.js"(exports, module) {
    var reWhitespace = /\s/;
    function trimmedEndIndex(string) {
      var index = string.length;
      while (index-- && reWhitespace.test(string.charAt(index))) {
      }
      return index;
    }
    module.exports = trimmedEndIndex;
  }
});

// node_modules/lodash/_baseTrim.js
var require_baseTrim = __commonJS({
  "node_modules/lodash/_baseTrim.js"(exports, module) {
    var trimmedEndIndex = require_trimmedEndIndex();
    var reTrimStart = /^\s+/;
    function baseTrim(string) {
      return string ? string.slice(0, trimmedEndIndex(string) + 1).replace(reTrimStart, "") : string;
    }
    module.exports = baseTrim;
  }
});

// node_modules/lodash/_Symbol.js
var require_Symbol = __commonJS({
  "node_modules/lodash/_Symbol.js"(exports, module) {
    var root = require_root();
    var Symbol = root.Symbol;
    module.exports = Symbol;
  }
});

// node_modules/lodash/_getRawTag.js
var require_getRawTag = __commonJS({
  "node_modules/lodash/_getRawTag.js"(exports, module) {
    var Symbol = require_Symbol();
    var objectProto = Object.prototype;
    var hasOwnProperty = objectProto.hasOwnProperty;
    var nativeObjectToString = objectProto.toString;
    var symToStringTag = Symbol ? Symbol.toStringTag : void 0;
    function getRawTag(value) {
      var isOwn = hasOwnProperty.call(value, symToStringTag), tag = value[symToStringTag];
      try {
        value[symToStringTag] = void 0;
        var unmasked = true;
      } catch (e) {
      }
      var result = nativeObjectToString.call(value);
      if (unmasked) {
        if (isOwn) {
          value[symToStringTag] = tag;
        } else {
          delete value[symToStringTag];
        }
      }
      return result;
    }
    module.exports = getRawTag;
  }
});

// node_modules/lodash/_objectToString.js
var require_objectToString = __commonJS({
  "node_modules/lodash/_objectToString.js"(exports, module) {
    var objectProto = Object.prototype;
    var nativeObjectToString = objectProto.toString;
    function objectToString(value) {
      return nativeObjectToString.call(value);
    }
    module.exports = objectToString;
  }
});

// node_modules/lodash/_baseGetTag.js
var require_baseGetTag = __commonJS({
  "node_modules/lodash/_baseGetTag.js"(exports, module) {
    var Symbol = require_Symbol();
    var getRawTag = require_getRawTag();
    var objectToString = require_objectToString();
    var nullTag = "[object Null]";
    var undefinedTag = "[object Undefined]";
    var symToStringTag = Symbol ? Symbol.toStringTag : void 0;
    function baseGetTag(value) {
      if (value == null) {
        return value === void 0 ? undefinedTag : nullTag;
      }
      return symToStringTag && symToStringTag in Object(value) ? getRawTag(value) : objectToString(value);
    }
    module.exports = baseGetTag;
  }
});

// node_modules/lodash/isObjectLike.js
var require_isObjectLike = __commonJS({
  "node_modules/lodash/isObjectLike.js"(exports, module) {
    function isObjectLike(value) {
      return value != null && typeof value == "object";
    }
    module.exports = isObjectLike;
  }
});

// node_modules/lodash/isSymbol.js
var require_isSymbol = __commonJS({
  "node_modules/lodash/isSymbol.js"(exports, module) {
    var baseGetTag = require_baseGetTag();
    var isObjectLike = require_isObjectLike();
    var symbolTag = "[object Symbol]";
    function isSymbol(value) {
      return typeof value == "symbol" || isObjectLike(value) && baseGetTag(value) == symbolTag;
    }
    module.exports = isSymbol;
  }
});

// node_modules/lodash/toNumber.js
var require_toNumber = __commonJS({
  "node_modules/lodash/toNumber.js"(exports, module) {
    var baseTrim = require_baseTrim();
    var isObject = require_isObject();
    var isSymbol = require_isSymbol();
    var NAN = 0 / 0;
    var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;
    var reIsBinary = /^0b[01]+$/i;
    var reIsOctal = /^0o[0-7]+$/i;
    var freeParseInt = parseInt;
    function toNumber(value) {
      if (typeof value == "number") {
        return value;
      }
      if (isSymbol(value)) {
        return NAN;
      }
      if (isObject(value)) {
        var other = typeof value.valueOf == "function" ? value.valueOf() : value;
        value = isObject(other) ? other + "" : other;
      }
      if (typeof value != "string") {
        return value === 0 ? value : +value;
      }
      value = baseTrim(value);
      var isBinary = reIsBinary.test(value);
      return isBinary || reIsOctal.test(value) ? freeParseInt(value.slice(2), isBinary ? 2 : 8) : reIsBadHex.test(value) ? NAN : +value;
    }
    module.exports = toNumber;
  }
});

// node_modules/lodash/debounce.js
var require_debounce = __commonJS({
  "node_modules/lodash/debounce.js"(exports, module) {
    var isObject = require_isObject();
    var now = require_now();
    var toNumber = require_toNumber();
    var FUNC_ERROR_TEXT = "Expected a function";
    var nativeMax = Math.max;
    var nativeMin = Math.min;
    function debounce5(func, wait, options) {
      var lastArgs, lastThis, maxWait, result, timerId, lastCallTime, lastInvokeTime = 0, leading = false, maxing = false, trailing = true;
      if (typeof func != "function") {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      wait = toNumber(wait) || 0;
      if (isObject(options)) {
        leading = !!options.leading;
        maxing = "maxWait" in options;
        maxWait = maxing ? nativeMax(toNumber(options.maxWait) || 0, wait) : maxWait;
        trailing = "trailing" in options ? !!options.trailing : trailing;
      }
      function invokeFunc(time) {
        var args = lastArgs, thisArg = lastThis;
        lastArgs = lastThis = void 0;
        lastInvokeTime = time;
        result = func.apply(thisArg, args);
        return result;
      }
      function leadingEdge(time) {
        lastInvokeTime = time;
        timerId = setTimeout(timerExpired, wait);
        return leading ? invokeFunc(time) : result;
      }
      function remainingWait(time) {
        var timeSinceLastCall = time - lastCallTime, timeSinceLastInvoke = time - lastInvokeTime, timeWaiting = wait - timeSinceLastCall;
        return maxing ? nativeMin(timeWaiting, maxWait - timeSinceLastInvoke) : timeWaiting;
      }
      function shouldInvoke(time) {
        var timeSinceLastCall = time - lastCallTime, timeSinceLastInvoke = time - lastInvokeTime;
        return lastCallTime === void 0 || timeSinceLastCall >= wait || timeSinceLastCall < 0 || maxing && timeSinceLastInvoke >= maxWait;
      }
      function timerExpired() {
        var time = now();
        if (shouldInvoke(time)) {
          return trailingEdge(time);
        }
        timerId = setTimeout(timerExpired, remainingWait(time));
      }
      function trailingEdge(time) {
        timerId = void 0;
        if (trailing && lastArgs) {
          return invokeFunc(time);
        }
        lastArgs = lastThis = void 0;
        return result;
      }
      function cancel() {
        if (timerId !== void 0) {
          clearTimeout(timerId);
        }
        lastInvokeTime = 0;
        lastArgs = lastCallTime = lastThis = timerId = void 0;
      }
      function flush() {
        return timerId === void 0 ? result : trailingEdge(now());
      }
      function debounced() {
        var time = now(), isInvoking = shouldInvoke(time);
        lastArgs = arguments;
        lastThis = this;
        lastCallTime = time;
        if (isInvoking) {
          if (timerId === void 0) {
            return leadingEdge(lastCallTime);
          }
          if (maxing) {
            clearTimeout(timerId);
            timerId = setTimeout(timerExpired, wait);
            return invokeFunc(lastCallTime);
          }
        }
        if (timerId === void 0) {
          timerId = setTimeout(timerExpired, wait);
        }
        return result;
      }
      debounced.cancel = cancel;
      debounced.flush = flush;
      return debounced;
    }
    module.exports = debounce5;
  }
});

// node_modules/@visx/responsive/esm/hooks/useParentSize.js
var import_debounce = __toESM(require_debounce());
var import_react = __toESM(require_react());
var defaultIgnoreDimensions = [];
var defaultInitialSize = {
  width: 0,
  height: 0,
  top: 0,
  left: 0
};
function useParentSize() {
  let {
    initialSize = defaultInitialSize,
    debounceTime = 300,
    ignoreDimensions = defaultIgnoreDimensions,
    enableDebounceLeadingCall = true,
    resizeObserverPolyfill
  } = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
  const parentRef = (0, import_react.useRef)(null);
  const animationFrameID = (0, import_react.useRef)(0);
  const [state, setState] = (0, import_react.useState)({
    ...defaultInitialSize,
    ...initialSize
  });
  const resize = (0, import_react.useMemo)(() => {
    const normalized = Array.isArray(ignoreDimensions) ? ignoreDimensions : [ignoreDimensions];
    return (0, import_debounce.default)((incoming) => {
      setState((existing) => {
        const stateKeys = Object.keys(existing);
        const keysWithChanges = stateKeys.filter((key) => existing[key] !== incoming[key]);
        const shouldBail = keysWithChanges.every((key) => normalized.includes(key));
        return shouldBail ? existing : incoming;
      });
    }, debounceTime, {
      leading: enableDebounceLeadingCall
    });
  }, [debounceTime, enableDebounceLeadingCall, ignoreDimensions]);
  (0, import_react.useEffect)(() => {
    const LocalResizeObserver = resizeObserverPolyfill || window.ResizeObserver;
    const observer = new LocalResizeObserver((entries) => {
      entries.forEach((entry) => {
        const {
          left,
          top,
          width,
          height
        } = (entry == null ? void 0 : entry.contentRect) ?? {};
        animationFrameID.current = window.requestAnimationFrame(() => {
          resize({
            width,
            height,
            top,
            left
          });
        });
      });
    });
    if (parentRef.current) observer.observe(parentRef.current);
    return () => {
      window.cancelAnimationFrame(animationFrameID.current);
      observer.disconnect();
      resize.cancel();
    };
  }, [resize, resizeObserverPolyfill]);
  return {
    parentRef,
    resize,
    ...state
  };
}

// node_modules/@visx/responsive/esm/components/ParentSize.js
var import_jsx_runtime = __toESM(require_jsx_runtime());
var defaultParentSizeStyles = {
  width: "100%",
  height: "100%"
};
function ParentSize(_ref) {
  let {
    className,
    children,
    debounceTime,
    ignoreDimensions,
    initialSize,
    parentSizeStyles = defaultParentSizeStyles,
    enableDebounceLeadingCall = true,
    resizeObserverPolyfill,
    ...restProps
  } = _ref;
  const {
    parentRef,
    resize,
    ...dimensions
  } = useParentSize({
    initialSize,
    debounceTime,
    ignoreDimensions,
    enableDebounceLeadingCall,
    resizeObserverPolyfill
  });
  return (0, import_jsx_runtime.jsx)("div", {
    style: parentSizeStyles,
    ref: parentRef,
    className,
    ...restProps,
    children: children({
      ...dimensions,
      ref: parentRef.current,
      resize
    })
  });
}

// node_modules/@visx/responsive/esm/components/ScaleSVG.js
var import_jsx_runtime2 = __toESM(require_jsx_runtime());
function ScaleSVG(_ref) {
  let {
    children,
    width,
    height,
    xOrigin = 0,
    yOrigin = 0,
    preserveAspectRatio = "xMinYMin meet",
    innerRef
  } = _ref;
  return (0, import_jsx_runtime2.jsx)("div", {
    style: {
      display: "inline-block",
      position: "relative",
      width: "100%",
      verticalAlign: "top",
      overflow: "hidden"
    },
    children: (0, import_jsx_runtime2.jsx)("svg", {
      preserveAspectRatio,
      viewBox: `${xOrigin} ${yOrigin} ${width} ${height}`,
      ref: innerRef,
      children
    })
  });
}

// node_modules/@visx/responsive/esm/enhancers/withParentSize.js
var import_debounce2 = __toESM(require_debounce());
var import_react2 = __toESM(require_react());
var import_jsx_runtime3 = __toESM(require_jsx_runtime());
var CONTAINER_STYLES = {
  width: "100%",
  height: "100%"
};
function withParentSize(BaseComponent, resizeObserverPolyfill) {
  return class WrappedComponent extends import_react2.Component {
    constructor() {
      super(...arguments);
      __publicField(this, "displayName", (() => `withParentSize(${BaseComponent.displayName ?? BaseComponent.name ?? "Component"})`)());
      __publicField(this, "state", /* @__PURE__ */ (() => ({
        parentWidth: void 0,
        parentHeight: void 0
      }))());
      __publicField(this, "animationFrameID", 0);
      __publicField(this, "container", null);
      __publicField(this, "setRef", (ref) => {
        this.container = ref;
      });
      __publicField(this, "resize", (() => (0, import_debounce2.default)(
        // eslint-disable-next-line unicorn/consistent-function-scoping
        (_ref) => {
          let {
            width,
            height
          } = _ref;
          this.setState({
            parentWidth: width,
            parentHeight: height
          });
        },
        this.props.debounceTime ?? 300,
        {
          leading: this.props.enableDebounceLeadingCall ?? true
        }
      ))());
    }
    componentDidMount() {
      const ResizeObserverLocal = resizeObserverPolyfill || window.ResizeObserver;
      this.resizeObserver = new ResizeObserverLocal((entries) => {
        entries.forEach((entry) => {
          const {
            width,
            height
          } = entry.contentRect;
          this.animationFrameID = window.requestAnimationFrame(() => {
            this.resize({
              width,
              height
            });
          });
        });
      });
      if (this.container) this.resizeObserver.observe(this.container);
    }
    componentWillUnmount() {
      window.cancelAnimationFrame(this.animationFrameID);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.resize.cancel();
    }
    render() {
      const {
        initialWidth,
        initialHeight
      } = this.props;
      const {
        parentWidth = initialWidth,
        parentHeight = initialHeight
      } = this.state;
      return (0, import_jsx_runtime3.jsx)("div", {
        style: CONTAINER_STYLES,
        ref: this.setRef,
        children: parentWidth != null && parentHeight != null && (0, import_jsx_runtime3.jsx)(BaseComponent, {
          parentWidth,
          parentHeight,
          ...this.props
        })
      });
    }
  };
}

// node_modules/@visx/responsive/esm/enhancers/withScreenSize.js
var import_debounce3 = __toESM(require_debounce());
var import_react3 = __toESM(require_react());
var import_jsx_runtime4 = __toESM(require_jsx_runtime());
function withScreenSize(BaseComponent) {
  return class WrappedComponent extends import_react3.Component {
    constructor() {
      super(...arguments);
      __publicField(this, "displayName", (() => `withScreenSize(${BaseComponent.displayName ?? BaseComponent.name ?? "Component"})`)());
      __publicField(this, "state", /* @__PURE__ */ (() => ({
        screenWidth: void 0,
        screenHeight: void 0
      }))());
      __publicField(this, "resize", (() => (0, import_debounce3.default)(
        // eslint-disable-next-line unicorn/consistent-function-scoping
        () => {
          this.setState(() => ({
            screenWidth: window.innerWidth,
            screenHeight: window.innerHeight
          }));
        },
        this.props.debounceTime ?? this.props.windowResizeDebounceTime ?? 300,
        {
          leading: this.props.enableDebounceLeadingCall ?? true
        }
      ))());
    }
    componentDidMount() {
      window.addEventListener("resize", this.resize, false);
      this.resize();
    }
    componentWillUnmount() {
      window.removeEventListener("resize", this.resize, false);
      this.resize.cancel();
    }
    render() {
      const {
        screenWidth,
        screenHeight
      } = this.state;
      return screenWidth == null || screenHeight == null ? null : (0, import_jsx_runtime4.jsx)(BaseComponent, {
        screenWidth,
        screenHeight,
        ...this.props
      });
    }
  };
}

// node_modules/@visx/responsive/esm/hooks/useScreenSize.js
var import_debounce4 = __toESM(require_debounce());
var import_react4 = __toESM(require_react());
var defaultInitialSize2 = {
  width: 0,
  height: 0
};
var useScreenSize = function() {
  let {
    initialSize = defaultInitialSize2,
    debounceTime = 300,
    enableDebounceLeadingCall = true
  } = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
  const [screenSize, setScreenSize] = (0, import_react4.useState)(initialSize);
  const handleResize = (0, import_react4.useMemo)(() => (0, import_debounce4.default)(() => {
    setScreenSize(() => ({
      width: window.innerWidth,
      height: window.innerHeight
    }));
  }, debounceTime, {
    leading: enableDebounceLeadingCall
  }), [debounceTime, enableDebounceLeadingCall]);
  (0, import_react4.useEffect)(() => {
    handleResize();
    window.addEventListener("resize", handleResize, false);
    return () => {
      window.removeEventListener("resize", handleResize, false);
      handleResize.cancel();
    };
  }, [handleResize]);
  return screenSize;
};
var useScreenSize_default = useScreenSize;
export {
  ParentSize,
  ScaleSVG,
  useParentSize,
  useScreenSize_default as useScreenSize,
  withParentSize,
  withScreenSize
};
//# sourceMappingURL=@visx_responsive.js.map
