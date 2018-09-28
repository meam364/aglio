// This is an extremely simple example generator given refracted MSON input.
// It handles the following:
//
// * Simple types, enums, arrays, objects
// * Property descriptions
// * References
// * Mixins (Includes)
// * Arrays with members of different types
// * One Of properties (the first is always selected)
//
// It is missing support for many advanced features.
let renderExample;
const inherit = require("./inherit");

const defaultValue = function(type) {
  switch (type) {
    case "boolean":
      return true;
    case "number":
      return 1;
    case "string":
      return "Hello, world!";
  }
};

module.exports = renderExample = function(root, dataStructures) {
  let ref;
  switch (root.element) {
    case "boolean":
    case "string":
    case "number":
      if (root.content != null) {
        return root.content;
      } else {
        return defaultValue(root.element);
      }
    case "enum":
      return renderExample(root.content[0], dataStructures);
    case "array":
      return Array.from(root.content || []).map(item =>
        renderExample(item, dataStructures)
      );
    case "object":
      var obj = {};
      var properties = root.content.slice(0);
      var i = 0;
      while (i < properties.length) {
        let member = properties[i];
        i++;
        if (member.element === "ref") {
          ref = dataStructures[member.content.href];
          i--;
          properties.splice.apply(properties, [i, 1].concat(ref.content));
          continue;
        } else if (member.element === "select") {
          // Note: we *always* select the first choice!
          member = member.content[0].content[0];
        }
        const key = member.content.key.content;
        obj[key] = renderExample(member.content.value, dataStructures);
      }
      return obj;
    default:
      ref = dataStructures[root.element];
      if (ref) {
        return renderExample(inherit(ref, root), dataStructures);
      }
  }
};
