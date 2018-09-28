// This is an extremely simple JSON Schema generator given refracted MSON input.
// It handles the following:
//
// * Simple types, enums, arrays, objects
// * Property descriptions
// * Required, default, nullable properties
// * References
// * Mixins (Includes)
// * Arrays with members of different types
// * One Of (mutually exclusive) properties
//
// It is missing support for many advanced features.
let renderSchema;
const { deepEqual } = require("assert");
const inherit = require("./inherit");

module.exports = renderSchema = function(root, dataStructures) {
  let ref;
  let typeAttr;
  let schema = {};
  switch (root.element) {
    case "boolean":
    case "string":
    case "number":
      schema.type = root.element;
      if (
        (root.attributes != null ? root.attributes.default : undefined) != null
      ) {
        schema.default = root.attributes.default;
      }
      break;
    case "enum":
      schema.enum = [];
      for (var item of Array.from(root.content || [])) {
        schema.enum.push(item.content);
      }
      break;
    case "array":
      schema.type = "array";
      var items = [];
      for (item of Array.from(root.content || [])) {
        items.push(renderSchema(item, dataStructures));
      }
      if (items.length === 1) {
        schema.items = items[0];
      } else if (items.length > 1) {
        try {
          schema.items = items.reduce((l, r) => deepEqual(l, r) || r);
        } catch (error) {
          schema.items = { anyOf: items };
        }
      }
      break;
    case "object":
    case "option":
      schema.type = "object";
      schema.properties = {};
      var required = [];
      var properties = root.content.slice(0);
      var i = 0;
      while (i < properties.length) {
        var key;
        const member = properties[i];
        i++;
        if (member.element === "ref") {
          ref = dataStructures[member.content.href];
          i--;
          properties.splice.apply(properties, [i, 1].concat(ref.content));
          continue;
        } else if (member.element === "select") {
          const exclusive = [];
          for (let option of Array.from(member.content)) {
            const optionSchema = renderSchema(option, dataStructures);
            for (key in optionSchema.properties) {
              const prop = optionSchema.properties[key];
              exclusive.push(key);
              schema.properties[key] = prop;
            }
          }
          if (!schema.allOf) {
            schema.allOf = [];
          }
          schema.allOf.push({ not: { required: exclusive } });
          continue;
        }
        key = member.content.key.content;
        schema.properties[key] = renderSchema(
          member.content.value,
          dataStructures
        );
        if (
          (member.meta != null ? member.meta.description : undefined) != null
        ) {
          schema.properties[key].description = member.meta.description;
        }
        if (
          member.attributes != null
            ? member.attributes.typeAttributes
            : undefined
        ) {
          typeAttr = member.attributes.typeAttributes;
          if (typeAttr.indexOf("required") !== -1) {
            if (required.indexOf(key) === -1) {
              required.push(key);
            }
          }
          if (typeAttr.indexOf("nullable") !== -1) {
            schema.properties[key].type = [schema.properties[key].type, "null"];
          }
        }
      }
      if (required.length) {
        schema.required = required;
      }
      break;
    default:
      ref = dataStructures[root.element];
      if (ref) {
        schema = renderSchema(inherit(ref, root), dataStructures);
      }
  }

  if ((root.meta != null ? root.meta.description : undefined) != null) {
    schema.description = root.meta.description;
  }

  if (root.attributes != null ? root.attributes.typeAttributes : undefined) {
    typeAttr = root.attributes.typeAttributes;
    if (typeAttr.indexOf("nullable") !== -1) {
      schema.type = [schema.type, "null"];
    }
  }
  return schema;
};
