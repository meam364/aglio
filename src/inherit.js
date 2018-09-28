// Handle MSON inheritance. This is interesting because certain attributes,
// items, members, etc can be overridden. For example, the `id` property is
// overridden to be any valid `string` below:
//
// # My Type
// + id (number)
// + name (string)
//
// # Another Type (My Type)
// + id (string)

// Make sure all members are unique, removing all duplicates before the last
// occurence of the member key name.
const uniqueMembers = function(content) {
  const known = [];
  let i = content.length - 1;
  return (() => {
    const result = [];
    while (i >= 0) {
      if (content[i].element === "member") {
        const key = content[i].content.key.content;
        if (known.indexOf(key) !== -1) {
          content.splice(i, 1);
          continue;
        }
        known.push(key);
      }
      result.push(i--);
    }
    return result;
  })();
};

// Have `element` inherit from `base`.
module.exports = function(base, element) {
  // First, we do a deep copy of the base (parent) element
  let key, value;
  const combined = JSON.parse(JSON.stringify(base));

  // Next, we copy or overwrite any metadata and attributes
  if (element.meta) {
    if (combined.meta == null) {
      combined.meta = {};
    }
    for (key of Object.keys(element.meta || {})) {
      value = element.meta[key];
      combined.meta[key] = value;
    }
  }
  if (element.attributes) {
    if (combined.attributes == null) {
      combined.attributes = {};
    }
    for (key of Object.keys(element.attributes || {})) {
      value = element.attributes[key];
      combined.attributes[key] = value;
    }
  }

  // Lastly, we combine the content if we can. For simple types, this means
  // overwriting the content. For arrays it adds to the content list and for
  // objects is adds *or* overwrites (if an existing key already exists).
  if (element.content) {
    if (
      (combined.content != null ? combined.content.push : undefined) ||
      (element.content != null ? element.content.push : undefined)
    ) {
      // This could be an object or array
      if (combined.content == null) {
        combined.content = [];
      }
      for (let item of Array.from(element.content)) {
        combined.content.push(item);
      }

      if (combined.content.length && combined.content[0].element === "member") {
        // This is probably an object - remove duplicate keys!
        uniqueMembers(combined.content);
      }
    } else {
      // Not an array or object, just overwrite the content
      combine.content = element.content;
    }
  }
  return combined;
};
