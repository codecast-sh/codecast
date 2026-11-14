"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
exports.id = "vendor-chunks/micromark-util-encode";
exports.ids = ["vendor-chunks/micromark-util-encode"];
exports.modules = {

/***/ "(ssr)/../../node_modules/micromark-util-encode/index.js":
/*!*********************************************************!*\
  !*** ../../node_modules/micromark-util-encode/index.js ***!
  \*********************************************************/
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   encode: () => (/* binding */ encode)\n/* harmony export */ });\nconst characterReferences = {'\"': 'quot', '&': 'amp', '<': 'lt', '>': 'gt'}\n\n/**\n * Encode only the dangerous HTML characters.\n *\n * This ensures that certain characters which have special meaning in HTML are\n * dealt with.\n * Technically, we can skip `>` and `\"` in many cases, but CM includes them.\n *\n * @param {string} value\n *   Value to encode.\n * @returns {string}\n *   Encoded value.\n */\nfunction encode(value) {\n  return value.replace(/[\"&<>]/g, replace)\n\n  /**\n   * @param {string} value\n   *   Value to replace.\n   * @returns {string}\n   *   Encoded value.\n   */\n  function replace(value) {\n    return (\n      '&' +\n      characterReferences[\n        /** @type {keyof typeof characterReferences} */ (value)\n      ] +\n      ';'\n    )\n  }\n}\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHNzcikvLi4vLi4vbm9kZV9tb2R1bGVzL21pY3JvbWFyay11dGlsLWVuY29kZS9pbmRleC5qcyIsIm1hcHBpbmdzIjoiOzs7O0FBQUEsNkJBQTZCOztBQUU3QjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFdBQVcsUUFBUTtBQUNuQjtBQUNBLGFBQWE7QUFDYjtBQUNBO0FBQ087QUFDUDs7QUFFQTtBQUNBLGFBQWEsUUFBUTtBQUNyQjtBQUNBLGVBQWU7QUFDZjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxtQkFBbUIsa0NBQWtDO0FBQ3JEO0FBQ0EsUUFBUTtBQUNSO0FBQ0E7QUFDQSIsInNvdXJjZXMiOlsiL1VzZXJzL2FzaG90L3NyYy9jb2RlY2FzdC9ub2RlX21vZHVsZXMvbWljcm9tYXJrLXV0aWwtZW5jb2RlL2luZGV4LmpzIl0sInNvdXJjZXNDb250ZW50IjpbImNvbnN0IGNoYXJhY3RlclJlZmVyZW5jZXMgPSB7J1wiJzogJ3F1b3QnLCAnJic6ICdhbXAnLCAnPCc6ICdsdCcsICc+JzogJ2d0J31cblxuLyoqXG4gKiBFbmNvZGUgb25seSB0aGUgZGFuZ2Vyb3VzIEhUTUwgY2hhcmFjdGVycy5cbiAqXG4gKiBUaGlzIGVuc3VyZXMgdGhhdCBjZXJ0YWluIGNoYXJhY3RlcnMgd2hpY2ggaGF2ZSBzcGVjaWFsIG1lYW5pbmcgaW4gSFRNTCBhcmVcbiAqIGRlYWx0IHdpdGguXG4gKiBUZWNobmljYWxseSwgd2UgY2FuIHNraXAgYD5gIGFuZCBgXCJgIGluIG1hbnkgY2FzZXMsIGJ1dCBDTSBpbmNsdWRlcyB0aGVtLlxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSB2YWx1ZVxuICogICBWYWx1ZSB0byBlbmNvZGUuXG4gKiBAcmV0dXJucyB7c3RyaW5nfVxuICogICBFbmNvZGVkIHZhbHVlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW5jb2RlKHZhbHVlKSB7XG4gIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9bXCImPD5dL2csIHJlcGxhY2UpXG5cbiAgLyoqXG4gICAqIEBwYXJhbSB7c3RyaW5nfSB2YWx1ZVxuICAgKiAgIFZhbHVlIHRvIHJlcGxhY2UuXG4gICAqIEByZXR1cm5zIHtzdHJpbmd9XG4gICAqICAgRW5jb2RlZCB2YWx1ZS5cbiAgICovXG4gIGZ1bmN0aW9uIHJlcGxhY2UodmFsdWUpIHtcbiAgICByZXR1cm4gKFxuICAgICAgJyYnICtcbiAgICAgIGNoYXJhY3RlclJlZmVyZW5jZXNbXG4gICAgICAgIC8qKiBAdHlwZSB7a2V5b2YgdHlwZW9mIGNoYXJhY3RlclJlZmVyZW5jZXN9ICovICh2YWx1ZSlcbiAgICAgIF0gK1xuICAgICAgJzsnXG4gICAgKVxuICB9XG59XG4iXSwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbMF0sInNvdXJjZVJvb3QiOiIifQ==\n//# sourceURL=webpack-internal:///(ssr)/../../node_modules/micromark-util-encode/index.js\n");

/***/ })

};
;