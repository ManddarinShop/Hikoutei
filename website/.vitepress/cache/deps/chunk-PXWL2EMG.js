import {
  __publicField
} from "./chunk-DC5AMYBS.js";

// node_modules/@visx/point/esm/Point.js
var Point = class {
  constructor(_ref) {
    __publicField(this, "x", 0);
    __publicField(this, "y", 0);
    let {
      x = 0,
      y = 0
    } = _ref;
    this.x = x;
    this.y = y;
  }
  value() {
    return {
      x: this.x,
      y: this.y
    };
  }
  toArray() {
    return [this.x, this.y];
  }
};

export {
  Point
};
//# sourceMappingURL=chunk-PXWL2EMG.js.map
