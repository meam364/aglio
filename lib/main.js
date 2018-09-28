const crypto = require("crypto");
const fs = require("fs");
const hljs = require("highlight.js");
const jade = require("jade");
const less = require("less");
const markdownIt = require("markdown-it");
const moment = require("moment");
const path = require("path");
const querystring = require("querystring");

const renderExample = require("./example");
const renderSchema = require("./schema");

// The root directory of this project
const ROOT = path.dirname(__dirname);

let cache = {};

// Utility for benchmarking
const benchmark = {
  start(message) {
    if (process.env.BENCHMARK) {
      return console.time(message);
    }
  },
  end(message) {
    if (process.env.BENCHMARK) {
      return console.timeEnd(message);
    }
  }
};

// Extend an error's message. Returns the modified error.
const errMsg = function(message, err) {
  err.message = `${message}: ${err.message}`;
  return err;
};

// Generate a SHA1 hash
const sha1 = value =>
  crypto
    .createHash("sha1")
    .update(value.toString())
    .digest("hex");

// A function to create ID-safe slugs. If `unique` is passed, then
// unique slugs are returned for the same input. The cache is just
// a plain object where the keys are the sluggified name.
const slug = function(cache, value, unique) {
  if (cache == null) {
    cache = {};
  }
  if (value == null) {
    value = "";
  }
  if (unique == null) {
    unique = false;
  }
  let sluggified = value
    .toLowerCase()
    .replace(/[ \t\n\\<>"'=:/]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/, "");

  if (unique) {
    while (cache[sluggified]) {
      // Already exists, so let's try to make it unique.
      if (sluggified.match(/\d+$/)) {
        sluggified = sluggified.replace(/\d+$/, value => parseInt(value) + 1);
      } else {
        sluggified = sluggified + "-1";
      }
    }
  }

  cache[sluggified] = true;

  return sluggified;
};

// A function to highlight snippets of code. lang is optional and
// if given, is used to set the code language. If lang is no-highlight
// then no highlighting is performed.
const highlight = function(code, lang, subset) {
  benchmark.start(`highlight ${lang}`);
  const response = (() => {
    switch (lang) {
      case "no-highlight":
        return code;
      case undefined:
      case null:
      case "":
        return hljs.highlightAuto(code, subset).value;
      default:
        return hljs.highlight(lang, code).value;
    }
  })();
  benchmark.end(`highlight ${lang}`);
  return response.trim();
};

const getCached = function(key, compiledPath, sources, load, done) {
  // Disable the template/css caching?
  if (process.env.NOCACHE) {
    return done(null);
  }

  // Already loaded? Just return it!
  if (cache[key]) {
    return done(null, cache[key]);
  }

  // Next, try to check if the compiled path exists and is newer than all of
  // the sources. If so, load the compiled path into the in-memory cache.
  try {
    if (fs.existsSync(compiledPath)) {
      const compiledStats = fs.statSync(compiledPath);

      for (let source of Array.from(sources)) {
        const sourceStats = fs.statSync(source);
        if (sourceStats.mtime > compiledStats.mtime) {
          // There is a newer source file, so we ignore the compiled
          // version on disk. It'll be regenerated later.
          return done(null);
        }
      }

      try {
        return load(compiledPath, function(err, item) {
          if (err) {
            return done(errMsg("Error loading cached resource", err));
          }

          cache[key] = item;
          return done(null, cache[key]);
        });
      } catch (loadErr) {
        return done(errMsg("Error loading cached resource", loadErr));
      }
    } else {
      return done(null);
    }
  } catch (error) {
    const err = error;
    return done(err);
  }
};

const getCss = function(variables, styles, verbose, done) {
  // Get the CSS for the given variables and style. This method caches
  // its output, so subsequent calls will be extremely fast but will
  // not reload potentially changed data from disk.
  // The CSS is generated via a dummy LESS file with imports to the
  // default variables, any custom override variables, and the given
  // layout style. Both variables and style support special values,
  // for example `flatly` might load `styles/variables-flatly.less`.
  // See the `styles` directory for available options.
  let customPath;
  const key = `css-${variables}-${styles}`;
  if (cache[key]) {
    return done(null, cache[key]);
  }

  // Not cached in memory, but maybe it's already compiled on disk?
  const compiledPath = path.join(ROOT, "cache", `${sha1(key)}.css`);

  const defaultVariablePath = path.join(
    ROOT,
    "styles",
    "variables-default.less"
  );
  const sources = [defaultVariablePath];

  if (!Array.isArray(variables)) {
    variables = [variables];
  }
  if (!Array.isArray(styles)) {
    styles = [styles];
  }

  const variablePaths = [defaultVariablePath];
  for (var item of Array.from(variables)) {
    if (item !== "default") {
      customPath = path.join(ROOT, "styles", `variables-${item}.less`);
      if (!fs.existsSync(customPath)) {
        customPath = item;
        if (!fs.existsSync(customPath)) {
          return done(new Error(`${customPath} does not exist!`));
        }
      }
      variablePaths.push(customPath);
      sources.push(customPath);
    }
  }

  const stylePaths = [];
  for (item of Array.from(styles)) {
    customPath = path.join(ROOT, "styles", `layout-${item}.less`);
    if (!fs.existsSync(customPath)) {
      customPath = item;
      if (!fs.existsSync(customPath)) {
        return done(new Error(`${customPath} does not exist!`));
      }
    }
    stylePaths.push(customPath);
    sources.push(customPath);
  }

  const load = (filename, loadDone) => fs.readFile(filename, "utf-8", loadDone);

  if (verbose) {
    console.log(`Using variables ${variablePaths}`);
    console.log(`Using styles ${stylePaths}`);
    console.log(`Checking cache ${compiledPath}`);
  }

  return getCached(key, compiledPath, sources, load, function(err, css) {
    if (err) {
      return done(err);
    }
    if (css) {
      if (verbose) {
        console.log("Cached version loaded");
      }
      return done(null, css);
    }

    // Not cached, so let's create the file.
    if (verbose) {
      console.log("Not cached or out of date. Generating CSS...");
    }

    let tmp = "";

    for (customPath of Array.from(variablePaths)) {
      tmp += `@import \"${customPath}\";\n`;
    }

    for (customPath of Array.from(stylePaths)) {
      tmp += `@import \"${customPath}\";\n`;
    }

    benchmark.start("less-compile");
    return less.render(tmp, { compress: true }, function(err, result) {
      if (err) {
        return done(msgErr("Error processing LESS -> CSS", err));
      }

      try {
        ({ css } = result);
        fs.writeFileSync(compiledPath, css, "utf-8");
      } catch (writeErr) {
        return done(errMsg("Error writing cached CSS to file", writeErr));
      }

      benchmark.end("less-compile");

      cache[key] = css;
      return done(null, cache[key]);
    });
  });
};

const compileTemplate = function(filename, options) {
  let compiled;
  return (compiled = `\
var jade = require('jade/runtime');
${jade.compileFileClient(filename, options)}
module.exports = compiledFunc;\
`);
};

const getTemplate = function(name, verbose, done) {
  // Check if this is a built-in template name
  const builtin = path.join(ROOT, "templates", `${name}.jade`);
  if (!fs.existsSync(name) && fs.existsSync(builtin)) {
    name = builtin;
  }

  // Get the template function for the given path. This will load and
  // compile the template if necessary, and cache it for future use.
  const key = `template-${name}`;

  // Check if it is cached in memory. If not, then we'll check the disk.
  if (cache[key]) {
    return done(null, cache[key]);
  }

  // Check if it is compiled on disk and not older than the template file.
  // If not present or outdated, then we'll need to compile it.
  const compiledPath = path.join(ROOT, "cache", `${sha1(key)}.js`);

  const load = function(filename, loadDone) {
    try {
      const loaded = require(filename);
    } catch (loadErr) {
      return loadDone(errMsg("Unable to load template", loadErr));
    }

    return loadDone(null, require(filename));
  };

  if (verbose) {
    console.log(`Using template ${name}`);
    console.log(`Checking cache ${compiledPath}`);
  }

  return getCached(key, compiledPath, [name], load, function(err, template) {
    let compiled, compileErr;
    if (err) {
      return done(err);
    }
    if (template) {
      if (verbose) {
        console.log("Cached version loaded");
      }
      return done(null, template);
    }

    if (verbose) {
      console.log("Not cached or out of date. Generating template JS...");
    }

    // We need to compile the template, then cache it. This is interesting
    // because we are compiling to a client-side template, then adding some
    // module-specific code to make it work here. This allows us to save time
    // in the future by just loading the generated javascript function.
    benchmark.start("jade-compile");
    const compileOptions = {
      filename: name,
      name: "compiledFunc",
      self: true,
      compileDebug: false
    };

    try {
      compiled = compileTemplate(name, compileOptions);
    } catch (error) {
      compileErr = error;
      return done(errMsg("Error compiling template", compileErr));
    }

    if (compiled.indexOf("self.") === -1) {
      // Not using self, so we probably need to recompile into compatibility
      // mode. This is slower, but keeps things working with Jade files
      // designed for Aglio 1.x.
      compileOptions.self = false;

      try {
        compiled = compileTemplate(name, compileOptions);
      } catch (error1) {
        compileErr = error1;
        return done(errMsg("Error compiling template", compileErr));
      }
    }

    try {
      fs.writeFileSync(compiledPath, compiled, "utf-8");
    } catch (writeErr) {
      return done(errMsg("Error writing cached template file", writeErr));
    }

    benchmark.end("jade-compile");

    cache[key] = require(compiledPath);
    return done(null, cache[key]);
  });
};

const modifyUriTemplate = function(templateUri, parameters, colorize) {
  // Modify a URI template to only include the parameter names from
  // the given parameters. For example:
  // URI template: /pages/{id}{?verbose}
  // Parameters contains a single `id` parameter
  // Output: /pages/{id}
  let index;
  let param;
  const parameterValidator = b =>
    // Compare the names, removing the special `*` operator
    parameterNames.indexOf(querystring.unescape(b.replace(/^\*|\*$/, ""))) !==
    -1;
  var parameterNames = (() => {
    const result = [];
    for (param of Array.from(parameters)) {
      result.push(param.name);
    }
    return result;
  })();
  const parameterBlocks = [];
  let lastIndex = (index = 0);
  while ((index = templateUri.indexOf("{", index)) !== -1) {
    parameterBlocks.push(templateUri.substring(lastIndex, index));
    const block = {};
    const closeIndex = templateUri.indexOf("}", index);
    block.querySet = templateUri.indexOf("{?", index) === index;
    block.formSet = templateUri.indexOf("{&", index) === index;
    block.reservedSet = templateUri.indexOf("{+", index) === index;
    lastIndex = closeIndex + 1;
    index++;
    if (block.querySet || block.formSet || block.reservedSet) {
      index++;
    }
    const parameterSet = templateUri.substring(index, closeIndex);
    block.parameters = parameterSet.split(",").filter(parameterValidator);
    if (block.parameters.length) {
      parameterBlocks.push(block);
    }
  }
  parameterBlocks.push(templateUri.substring(lastIndex, templateUri.length));
  return parameterBlocks
    .reduce(function(uri, v) {
      if (typeof v === "string") {
        uri.push(v);
      } else {
        const segment = !colorize ? ["{"] : [];
        if (v.querySet) {
          segment.push("?");
        }
        if (v.formSet) {
          segment.push("&");
        }
        if (v.reservedSet && !colorize) {
          segment.push("+");
        }
        segment.push(
          v.parameters
            .map(function(name) {
              if (!colorize) {
                return name;
              } else {
                // TODO: handle errors here?
                name = name.replace(/^\*|\*$/, "");
                param =
                  parameters[
                    parameterNames.indexOf(querystring.unescape(name))
                  ];
                if (v.querySet || v.formSet) {
                  return (
                    `<span class=\"hljs-attribute\">${name}=</span>` +
                    `<span class=\"hljs-literal\">${param.example || ""}</span>`
                  );
                } else {
                  return `<span class=\"hljs-attribute\" title=\"${name}\">${param.example ||
                    name}</span>`;
                }
              }
            })
            .join(colorize ? "&" : ",")
        );
        if (!colorize) {
          segment.push("}");
        }
        uri.push(segment.join(""));
      }
      return uri;
    }, [])
    .join("")
    .replace(/\/+/g, "/");
};

const decorate = function(api, md, slugCache, verbose) {
  // Decorate an API Blueprint AST with various pieces of information that
  // will be useful for the theme. Anything that would significantly
  // complicate the Jade template should probably live here instead!

  // Use the slug caching mechanism
  let dataStructure, item;
  const slugify = slug.bind(slug, slugCache);

  // Find data structures. This is a temporary workaround until Drafter is
  // updated to support JSON Schema again.
  // TODO: Remove me when Drafter is released.
  const dataStructures = {};
  for (let category of Array.from(api.content || [])) {
    for (item of Array.from(category.content || [])) {
      if (item.element === "dataStructure") {
        dataStructure = item.content[0];
        dataStructures[dataStructure.meta.id] = dataStructure;
      }
    }
  }
  if (verbose) {
    console.log(`Known data structures: ${Object.keys(dataStructures)}`);
  }

  // API overview description
  if (api.description) {
    api.descriptionHtml = md.render(api.description);
    api.navItems = slugCache._nav;
    slugCache._nav = [];
  }

  for (let meta of Array.from(api.metadata || [])) {
    if (meta.name === "HOST") {
      api.host = meta.value;
    }
  }

  return (() => {
    const result = [];
    for (var resourceGroup of Array.from(api.resourceGroups || [])) {
      // Element ID and link
      resourceGroup.elementId = slugify(resourceGroup.name, true);
      resourceGroup.elementLink = `#${resourceGroup.elementId}`;

      // Description
      if (resourceGroup.description) {
        resourceGroup.descriptionHtml = md.render(resourceGroup.description);
        resourceGroup.navItems = slugCache._nav;
        slugCache._nav = [];
      }

      result.push(
        (() => {
          const result1 = [];
          for (var resource of Array.from(resourceGroup.resources || [])) {
            // Element ID and link
            resource.elementId = slugify(
              `${resourceGroup.name}-${resource.name}`,
              true
            );
            resource.elementLink = `#${resource.elementId}`;

            result1.push(
              (() => {
                const result2 = [];
                for (var action of Array.from(resource.actions || [])) {
                  // Element ID and link
                  action.elementId = slugify(
                    `${resourceGroup.name}-${resource.name}-${action.method}`,
                    true
                  );
                  action.elementLink = `#${action.elementId}`;

                  // Lowercase HTTP method name
                  action.methodLower = action.method.toLowerCase();

                  // Parameters may be defined on the action or on the
                  // parent resource. Resource parameters should be concatenated
                  // to the action-specific parameters if set.
                  if (!(action.attributes || {}).uriTemplate) {
                    if (!action.parameters || !action.parameters.length) {
                      action.parameters = resource.parameters;
                    } else if (resource.parameters) {
                      action.parameters = resource.parameters.concat(
                        action.parameters
                      );
                    }
                  }

                  // Remove any duplicates! This gives precedence to the parameters
                  // defined on the action.
                  const knownParams = {};
                  const newParams = [];
                  const reversed = (action.parameters || [])
                    .concat([])
                    .reverse();
                  for (let param of Array.from(reversed)) {
                    if (knownParams[param.name]) {
                      continue;
                    }
                    knownParams[param.name] = true;
                    newParams.push(param);
                  }

                  action.parameters = newParams.reverse();

                  // Set up the action's template URI
                  action.uriTemplate = modifyUriTemplate(
                    (action.attributes || {}).uriTemplate ||
                      resource.uriTemplate ||
                      "",
                    action.parameters
                  );

                  action.colorizedUriTemplate = modifyUriTemplate(
                    (action.attributes || {}).uriTemplate ||
                      resource.uriTemplate ||
                      "",
                    action.parameters,
                    true
                  );

                  // Examples have a content section only if they have a
                  // description, headers, body, or schema.
                  action.hasRequest = false;
                  result2.push(
                    Array.from(action.examples || []).map(example =>
                      (() => {
                        const result3 = [];
                        for (var name of ["requests", "responses"]) {
                          result3.push(
                            (() => {
                              const result4 = [];
                              for (item of Array.from(example[name] || [])) {
                                var err, schema;
                                if (name === "requests" && !action.hasRequest) {
                                  action.hasRequest = true;
                                }

                                // If there is no schema, but there are MSON attributes, then try
                                // to generate the schema. This will fail sometimes.
                                // TODO: Remove me when Drafter is released.
                                if (!item.schema && item.content) {
                                  for (dataStructure of Array.from(
                                    item.content
                                  )) {
                                    if (
                                      dataStructure.element === "dataStructure"
                                    ) {
                                      try {
                                        schema = renderSchema(
                                          dataStructure.content[0],
                                          dataStructures
                                        );
                                        schema["$schema"] =
                                          "http://json-schema.org/draft-04/schema#";
                                        item.schema = JSON.stringify(
                                          schema,
                                          null,
                                          2
                                        );
                                      } catch (error) {
                                        err = error;
                                        if (verbose) {
                                          console.log(
                                            JSON.stringify(
                                              dataStructure.content[0],
                                              null,
                                              2
                                            )
                                          );
                                          console.log(err);
                                        }
                                      }
                                    }
                                  }
                                }

                                if (
                                  item.content &&
                                  !process.env.DRAFTER_EXAMPLES
                                ) {
                                  for (dataStructure of Array.from(
                                    item.content
                                  )) {
                                    if (
                                      dataStructure.element === "dataStructure"
                                    ) {
                                      try {
                                        item.body = JSON.stringify(
                                          renderExample(
                                            dataStructure.content[0],
                                            dataStructures
                                          ),
                                          null,
                                          2
                                        );
                                      } catch (error1) {
                                        err = error1;
                                        if (verbose) {
                                          console.log(
                                            JSON.stringify(
                                              dataStructure.content[0],
                                              null,
                                              2
                                            )
                                          );
                                          console.log(err);
                                        }
                                      }
                                    }
                                  }
                                }

                                item.hasContent =
                                  item.description ||
                                  Object.keys(item.headers).length ||
                                  item.body ||
                                  item.schema;

                                // If possible, make the body/schema pretty
                                try {
                                  if (item.body) {
                                    item.body = JSON.stringify(
                                      JSON.parse(item.body),
                                      null,
                                      2
                                    );
                                  }
                                  if (item.schema) {
                                    result4.push(
                                      (item.schema = JSON.stringify(
                                        JSON.parse(item.schema),
                                        null,
                                        2
                                      ))
                                    );
                                  } else {
                                    result4.push(undefined);
                                  }
                                } catch (error2) {
                                  err = error2;
                                  result4.push(false);
                                }
                              }
                              return result4;
                            })()
                          );
                        }
                        return result3;
                      })()
                    )
                  );
                }
                return result2;
              })()
            );
          }
          return result1;
        })()
      );
    }
    return result;
  })();
};

// Get the theme's configuration, used by Aglio to present available
// options and confirm that the input blueprint is a supported
// version.
exports.getConfig = () => ({
  formats: ["1A"],
  options: [
    {
      name: "variables",
      description: "Color scheme name or path to custom variables",
      default: "default"
    },
    {
      name: "condense-nav",
      description: "Condense navigation links",
      boolean: true,
      default: true
    },
    {
      name: "full-width",
      description: "Use full window width",
      boolean: true,
      default: false
    },
    {
      name: "template",
      description: "Template name or path to custom template",
      default: "default"
    },
    {
      name: "style",
      description: "Layout style name or path to custom stylesheet"
    },
    {
      name: "emoji",
      description: "Enable support for emoticons",
      boolean: true,
      default: true
    }
  ]
});

// Render the blueprint with the given options using Jade and LESS
exports.render = function(input, options, done) {
  if (done == null) {
    done = options;
    options = {};
  }

  // Disable the template/css caching?
  if (process.env.NOCACHE) {
    cache = {};
  }

  // This is purely for backward-compatibility
  if (options.condenseNav) {
    options.themeCondenseNav = options.condenseNav;
  }
  if (options.fullWidth) {
    options.themeFullWidth = options.fullWidth;
  }

  // Setup defaults
  if (options.themeVariables == null) {
    options.themeVariables = "default";
  }
  if (options.themeStyle == null) {
    options.themeStyle = "default";
  }
  if (options.themeTemplate == null) {
    options.themeTemplate = "default";
  }
  if (options.themeCondenseNav == null) {
    options.themeCondenseNav = true;
  }
  if (options.themeFullWidth == null) {
    options.themeFullWidth = false;
  }

  // Transform built-in layout names to paths
  if (options.themeTemplate === "default") {
    options.themeTemplate = path.join(ROOT, "templates", "index.jade");
  }

  // Setup markdown with code highlighting and smartypants. This also enables
  // automatically inserting permalinks for headers.
  const slugCache = { _nav: [] };
  const md = markdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight
  })
    .use(require("markdown-it-anchor"), {
      slugify(value) {
        const output = `header-${slug(slugCache, value, true)}`;
        slugCache._nav.push([value, `#${output}`]);
        return output;
      },
      permalink: true,
      permalinkClass: "permalink"
    })
    .use(require("markdown-it-checkbox"))
    .use(require("markdown-it-container"), "note")
    .use(require("markdown-it-container"), "warning");

  if (options.themeEmoji) {
    md.use(require("markdown-it-emoji"));
  }

  // Enable code highlighting for unfenced code blocks
  md.renderer.rules.code_block = md.renderer.rules.fence;

  benchmark.start("decorate");
  decorate(input, md, slugCache, options.verbose);
  benchmark.end("decorate");

  benchmark.start("css-total");
  const { themeVariables, themeStyle, verbose } = options;
  return getCss(themeVariables, themeStyle, verbose, function(err, css) {
    if (err) {
      return done(errMsg("Could not get CSS", err));
    }
    benchmark.end("css-total");

    const locals = {
      api: input,
      condenseNav: options.themeCondenseNav,
      css,
      fullWidth: options.themeFullWidth,
      date: moment,
      hash(value) {
        return crypto
          .createHash("md5")
          .update(value.toString())
          .digest("hex");
      },
      highlight,
      markdown(content) {
        return md.render(content);
      },
      slug: slug.bind(slug, slugCache),
      urldec(value) {
        return querystring.unescape(value);
      }
    };

    const object = options.locals || {};
    for (let key in object) {
      const value = object[key];
      locals[key] = value;
    }

    benchmark.start("get-template");
    return getTemplate(options.themeTemplate, verbose, function(
      getTemplateErr,
      renderer
    ) {
      let html;
      if (getTemplateErr) {
        return done(errMsg("Could not get template", getTemplateErr));
      }
      benchmark.end("get-template");

      benchmark.start("call-template");
      try {
        html = renderer(locals);
      } catch (err) {
        return done(errMsg("Error calling template during rendering", err));
      }
      benchmark.end("call-template");
      return done(null, html);
    });
  });
};
