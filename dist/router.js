#!/usr/bin/env node
import { createRequire as __routerCreateRequire } from 'node:module';
const require = __routerCreateRequire(import.meta.url);

// src/cli/args.ts
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["json", "help", "dry-run"]);
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "id",
  "brief",
  "model",
  "effort",
  "feedback",
  "max-wall-minutes",
  "stall-minutes",
  "label",
  "log",
  "router-dir",
  "limit"
]);
function parseArgs(argv) {
  const verb = argv[0];
  const rest = argv.slice(1);
  const positionals = [];
  const flags = {};
  let passthrough;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--") {
      passthrough = rest.slice(i + 1);
      positionals.push(...passthrough);
      break;
    }
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
      } else if (VALUE_FLAGS.has(body)) {
        const next = rest[i + 1];
        if (next !== void 0 && !next.startsWith("--")) {
          flags[body] = next;
          i += 1;
        } else {
          flags[body] = "";
        }
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { verb, positionals, flags, passthrough };
}
function flagStr(flags, key) {
  const v = flags[key];
  return typeof v === "string" ? v : void 0;
}
function flagBool(flags, key) {
  return flags[key] === true;
}

// src/cli/commands.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync6, readdirSync as readdirSync3, readFileSync as readFileSync6, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join6, resolve as resolve4 } from "node:path";

// node_modules/js-yaml/dist/js-yaml.mjs
var NOT_RESOLVED = /* @__PURE__ */ Symbol("NOT_RESOLVED");
function defineScalarTag(tagName, options) {
  return {
    tagName,
    nodeKind: "scalar",
    implicit: options.implicit ?? false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    implicitFirstChars: options.implicitFirstChars ?? null,
    resolve: options.resolve,
    identify: options.identify,
    represent: options.represent ?? ((data) => String(data)),
    representTagName: options.representTagName ?? (() => tagName)
  };
}
function defineSequenceTag(tagName, options) {
  const carrierIsResult = options.finalize === void 0;
  return {
    tagName,
    nodeKind: "sequence",
    implicit: false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    create: options.create,
    addItem: options.addItem,
    finalize: options.finalize ?? ((carrier) => carrier),
    carrierIsResult,
    identify: options.identify,
    represent: options.represent ?? ((data) => data),
    representTagName: options.representTagName ?? (() => tagName)
  };
}
function defineMappingTag(tagName, options) {
  const carrierIsResult = options.finalize === void 0;
  return {
    tagName,
    nodeKind: "mapping",
    implicit: false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    create: options.create,
    addPair: options.addPair,
    has: options.has,
    keys: options.keys,
    get: options.get,
    finalize: options.finalize ?? ((carrier) => carrier),
    carrierIsResult,
    identify: options.identify,
    represent: options.represent ?? ((data) => data),
    representTagName: options.representTagName ?? (() => tagName)
  };
}
var strTag = defineScalarTag("tag:yaml.org,2002:str", {
  resolve: (source) => source,
  identify: (data) => typeof data === "string"
});
var NULL_VALUES$1 = [
  "",
  "~",
  "null",
  "Null",
  "NULL"
];
var nullCoreTag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: [
    "",
    "~",
    "n",
    "N"
  ],
  resolve: (source) => {
    if (NULL_VALUES$1.indexOf(source) !== -1) return null;
    return NOT_RESOLVED;
  },
  identify: (object) => object === null,
  represent: () => "null"
});
var nullJsonTag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: ["n"],
  resolve: (source, isExplicit) => {
    if (source === "null" || isExplicit && source === "") return null;
    return NOT_RESOLVED;
  },
  identify: (object) => object === null,
  represent: () => "null"
});
var NULL_VALUES = [
  "",
  "~",
  "null",
  "Null",
  "NULL"
];
var nullYaml11Tag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: [
    "",
    "~",
    "n",
    "N"
  ],
  resolve: (source) => {
    if (NULL_VALUES.indexOf(source) !== -1) return null;
    return NOT_RESOLVED;
  },
  identify: (object) => object === null,
  represent: () => "null"
});
var TRUE_VALUES$2 = [
  "true",
  "True",
  "TRUE"
];
var FALSE_VALUES$2 = [
  "false",
  "False",
  "FALSE"
];
var boolCoreTag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: [
    "t",
    "T",
    "f",
    "F"
  ],
  resolve: (source) => {
    if (TRUE_VALUES$2.indexOf(source) !== -1) return true;
    if (FALSE_VALUES$2.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
  represent: (object) => object ? "true" : "false"
});
var TRUE_VALUES$1 = ["true"];
var FALSE_VALUES$1 = ["false"];
var boolJsonTag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: ["t", "f"],
  resolve: (source) => {
    if (TRUE_VALUES$1.indexOf(source) !== -1) return true;
    if (FALSE_VALUES$1.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
  represent: (object) => object ? "true" : "false"
});
var TRUE_VALUES = [
  "true",
  "True",
  "TRUE",
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "on",
  "On",
  "ON"
];
var FALSE_VALUES = [
  "false",
  "False",
  "FALSE",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "off",
  "Off",
  "OFF"
];
var boolYaml11Tag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: [
    "y",
    "Y",
    "n",
    "N",
    "t",
    "T",
    "f",
    "F",
    "o",
    "O"
  ],
  resolve: (source) => {
    if (TRUE_VALUES.indexOf(source) !== -1) return true;
    if (FALSE_VALUES.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
  represent: (object) => object ? "true" : "false"
});
var YAML_INTEGER_IMPLICIT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:0o[0-7]+|0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
var YAML_INTEGER_EXPLICIT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
function parseYamlInteger$2(source) {
  let value = source;
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0o")) return sign * parseInt(value.slice(2), 8);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger$2(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_INTEGER_EXPLICIT_PATTERN$1.test(source)) return NOT_RESOLVED;
  } else if (!YAML_INTEGER_IMPLICIT_PATTERN$1.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger$2(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intCoreTag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ..."0123456789"
  ],
  resolve: resolveYamlInteger$2,
  identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
  represent: (object) => object.toString(10)
});
var YAML_INTEGER_IMPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^-?(?:0|[1-9][0-9]*)$");
var YAML_INTEGER_EXPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
function parseYamlInteger$1(source) {
  let value = source;
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0o")) return sign * parseInt(value.slice(2), 8);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger$1(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_INTEGER_EXPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  } else if (!YAML_INTEGER_IMPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger$1(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intJsonTag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: ["-", ..."0123456789"],
  resolve: resolveYamlInteger$1,
  identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
  represent: (object) => object.toString(10)
});
var YAML_INTEGER_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?0x[0-9a-fA-F_]+|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+|[-+]?(?:0|[1-9][0-9_]*))$");
function parseYamlInteger(source) {
  let value = source.replace(/_/g, "");
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  if (value.includes(":")) {
    let result = 0;
    for (const part of value.split(":")) result = result * 60 + Number(part);
    return sign * result;
  }
  if (value !== "0" && value[0] === "0") return sign * parseInt(value, 8);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger(source) {
  if (!YAML_INTEGER_PATTERN.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intYaml11Tag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ..."0123456789"
  ],
  resolve: resolveYamlInteger,
  identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
  represent: (object) => object.toString(10)
});
var YAML_FLOAT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
var YAML_FLOAT_SPECIAL_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat$2(source) {
  if (!YAML_FLOAT_PATTERN$1.test(source)) return NOT_RESOLVED;
  let value = source.toLowerCase();
  const sign = value[0] === "-" ? -1 : 1;
  if ("+-".includes(value[0])) value = value.slice(1);
  if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  if (value === ".nan") return NaN;
  const result = sign * parseFloat(value);
  if (Number.isFinite(result) || YAML_FLOAT_SPECIAL_PATTERN$1.test(source)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat$2(object) {
  if (isNaN(object)) return ".nan";
  if (object === Number.POSITIVE_INFINITY) return ".inf";
  if (object === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object, -0)) return "-0.0";
  const result = object.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatCoreTag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ".",
    ..."0123456789"
  ],
  resolve: resolveYamlFloat$2,
  identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat$2
});
var YAML_FLOAT_IMPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$");
var YAML_FLOAT_EXPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat$1(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_FLOAT_EXPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
    let value = source.toLowerCase();
    const sign = value[0] === "-" ? -1 : 1;
    if ("+-".includes(value[0])) value = value.slice(1);
    if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    if (value === ".nan") return NaN;
    const result2 = sign * parseFloat(value);
    return Number.isFinite(result2) ? result2 : NOT_RESOLVED;
  }
  if (!YAML_FLOAT_IMPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  const result = Number(source);
  if (Number.isFinite(result)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat$1(object) {
  if (isNaN(object)) return ".nan";
  if (object === Number.POSITIVE_INFINITY) return ".inf";
  if (object === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object, -0)) return "-0.0";
  const result = object.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatJsonTag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: ["-", ..."0123456789"],
  resolve: resolveYamlFloat$1,
  identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat$1
});
var YAML_FLOAT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?(?:(?:[0-9][0-9_]*)?\\.[0-9_]*)(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\\.[0-9_]*|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
var YAML_FLOAT_SPECIAL_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat(source) {
  if (!YAML_FLOAT_PATTERN.test(source)) return NOT_RESOLVED;
  let value = source.toLowerCase().replace(/_/g, "");
  const sign = value[0] === "-" ? -1 : 1;
  if ("+-".includes(value[0])) value = value.slice(1);
  if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  if (value === ".nan") return NaN;
  let result = 0;
  if (value.includes(":")) {
    for (const part of value.split(":")) result = result * 60 + Number(part);
    result *= sign;
  } else result = sign * parseFloat(value);
  if (Number.isFinite(result) || YAML_FLOAT_SPECIAL_PATTERN.test(source)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat(object) {
  if (isNaN(object)) return ".nan";
  if (object === Number.POSITIVE_INFINITY) return ".inf";
  if (object === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object, -0)) return "-0.0";
  const result = object.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatYaml11Tag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ".",
    ..."0123456789"
  ],
  resolve: resolveYamlFloat,
  identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat
});
var mergeTag = defineScalarTag("tag:yaml.org,2002:merge", {
  implicit: true,
  implicitFirstChars: ["<"],
  resolve: (source, isExplicit) => {
    if (source === "<<" || isExplicit && source === "") return "<<";
    return NOT_RESOLVED;
  },
  identify: () => false
});
var BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
function resolveYamlBinary(source) {
  const input = source.replace(/\s/g, "");
  if (input.length % 4 !== 0 || !BASE64_PATTERN.test(input)) return NOT_RESOLVED;
  const binary = atob(input);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  return result;
}
function representYamlBinary(object) {
  let binary = "";
  for (let index = 0; index < object.length; index++) binary += String.fromCharCode(object[index]);
  return btoa(binary);
}
var binaryTag = defineScalarTag("tag:yaml.org,2002:binary", {
  resolve: resolveYamlBinary,
  identify: (object) => Object.prototype.toString.call(object) === "[object Uint8Array]",
  represent: representYamlBinary
});
var YAML_DATE_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$");
var YAML_TIMESTAMP_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$");
function makeUtcDate(year, month, day, hour = 0, minute = 0, second = 0, fraction = 0) {
  const date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
  date.setUTCFullYear(year, month, day);
  return date;
}
function resolveYamlTimestamp(source) {
  let match = YAML_DATE_REGEXP.exec(source);
  if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(source);
  if (match === null) return NOT_RESOLVED;
  const year = +match[1];
  const month = +match[2] - 1;
  const day = +match[3];
  if (!match[4]) {
    const date2 = makeUtcDate(year, month, day);
    if (date2.getUTCFullYear() !== year || date2.getUTCMonth() !== month || date2.getUTCDate() !== day) return NOT_RESOLVED;
    return date2;
  }
  const hour = +match[4];
  const minute = +match[5];
  const second = +match[6];
  let fraction = 0;
  if (hour > 23 || minute > 59 || second > 59) return NOT_RESOLVED;
  if (match[7]) {
    let value = match[7].slice(0, 3);
    while (value.length < 3) value += "0";
    fraction = +value;
  }
  const date = makeUtcDate(year, month, day, hour, minute, second, fraction);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return NOT_RESOLVED;
  if (match[9]) {
    const offsetHour = +match[10];
    const offsetMinute = +(match[11] || 0);
    if (offsetHour > 23 || offsetMinute > 59) return NOT_RESOLVED;
    const offset = (offsetHour * 60 + offsetMinute) * 6e4;
    date.setTime(date.getTime() - (match[9] === "-" ? -offset : offset));
  }
  return date;
}
var timestampTag = defineScalarTag("tag:yaml.org,2002:timestamp", {
  implicit: true,
  implicitFirstChars: [..."0123456789"],
  resolve: resolveYamlTimestamp,
  identify: (object) => object instanceof Date,
  represent: (object) => object.toISOString()
});
var seqTag = defineSequenceTag("tag:yaml.org,2002:seq", {
  create: () => [],
  addItem: (container, item) => {
    container.push(item);
  },
  identify: Array.isArray
});
function isPlainObject(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const prototype = Object.getPrototypeOf(data);
  return prototype === null || prototype === Object.prototype;
}
function pick(object, keys) {
  const result = {};
  for (const key of keys) if (object[key] !== void 0) result[key] = object[key];
  return result;
}
var omapTag = defineSequenceTag("tag:yaml.org,2002:omap", {
  create: () => ({
    list: [],
    seen: /* @__PURE__ */ new Set()
  }),
  addItem: (carrier, item) => {
    let key;
    if (item instanceof Map) {
      if (item.size !== 1) return "cannot resolve an ordered map item";
      key = item.keys().next().value;
    } else if (isPlainObject(item)) {
      const itemKeys = Object.keys(item);
      if (itemKeys.length !== 1) return "cannot resolve an ordered map item";
      key = itemKeys[0];
    } else return "cannot resolve an ordered map item";
    if (carrier.seen.has(key)) return "duplicate key in ordered map";
    carrier.seen.add(key);
    carrier.list.push(item);
    return "";
  },
  finalize: (carrier) => carrier.list,
  identify: () => false
});
var pairsTag = defineSequenceTag("tag:yaml.org,2002:pairs", {
  create: () => [],
  addItem: (container, item) => {
    if (item instanceof Map) {
      if (item.size !== 1) return "cannot resolve a pairs item";
      container.push(item.entries().next().value);
      return "";
    }
    if (Object.prototype.toString.call(item) !== "[object Object]") return "cannot resolve a pairs item";
    const object = item;
    const keys = Object.keys(object);
    if (keys.length !== 1) return "cannot resolve a pairs item";
    container.push([keys[0], object[keys[0]]]);
    return "";
  },
  identify: () => false
});
var mapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => ({}),
  identify: isPlainObject,
  represent: (o) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of Object.keys(o)) map.set(key, o[key]);
    return map;
  },
  addPair: (container, key, value) => {
    if (key !== null && typeof key === "object") return "object-based map does not support complex keys";
    const normalizedKey = String(key);
    if (normalizedKey === "__proto__") Object.defineProperty(container, normalizedKey, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    else container[normalizedKey] = value;
    return "";
  },
  has: (container, key) => {
    if (key !== null && typeof key === "object") return false;
    return Object.prototype.hasOwnProperty.call(container, String(key));
  },
  keys: (container) => Object.keys(container),
  get: (container, key) => {
    const normalizedKey = String(key);
    if (!Object.prototype.hasOwnProperty.call(container, normalizedKey)) return null;
    return container[normalizedKey];
  }
});
var setTag = defineMappingTag("tag:yaml.org,2002:set", {
  create: () => /* @__PURE__ */ new Set(),
  identify: (data) => data instanceof Set,
  represent: (data) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of data) map.set(key, null);
    return map;
  },
  addPair: (container, key, value) => {
    if (value !== null) return "cannot resolve a set item";
    container.add(key);
    return "";
  },
  has: (container, key) => container.has(key),
  keys: (container) => container.keys(),
  get: () => null
});
function createTagDefinitionMap() {
  return {
    scalar: /* @__PURE__ */ Object.create(null),
    sequence: /* @__PURE__ */ Object.create(null),
    mapping: /* @__PURE__ */ Object.create(null)
  };
}
function createTagDefinitionListMap() {
  return {
    scalar: [],
    sequence: [],
    mapping: []
  };
}
function compileTags(tags) {
  const result = [];
  for (const tag of tags) {
    let index = result.length;
    for (let previousIndex = 0; previousIndex < result.length; previousIndex++) {
      const previous = result[previousIndex];
      if (previous.nodeKind === tag.nodeKind && previous.tagName === tag.tagName && previous.matchByTagPrefix === tag.matchByTagPrefix) {
        index = previousIndex;
        break;
      }
    }
    result[index] = tag;
  }
  return result;
}
var Schema = class Schema2 {
  tags;
  /** @internal */
  implicitScalarTags;
  /**
  * Dispatch implicit scalar resolvers by `source.charAt(0)`. Each bucket holds
  * the resolvers that may match that key, in schema order; a key absent from
  * the map uses
  * {@link Schema.implicitScalarAnyFirstChar}
  * (resolvers that declared no first-char constraint, so they apply to any
  * first character).
  */
  implicitScalarByFirstChar;
  implicitScalarAnyFirstChar;
  /**
  * The default scalar tag (`!!str`), resolved once so the composer's fallback
  * for unresolved plain scalars avoids a keyed lookup per scalar.
  *
  * @internal
  */
  defaultScalarTag;
  /**
  * The default container tags (`!!seq` / `!!map`), used by the dumper: when a
  * value is identified by its default tag, the tag is implicit and not
  * printed. Undefined if the schema does not define them (then such values
  * can't be dumped).
  *
  * @internal
  */
  defaultSequenceTag;
  /** @internal */
  defaultMappingTag;
  exact;
  prefix;
  constructor(tags) {
    const compiledTags = compileTags(tags);
    const implicitScalarTags = [];
    const exact = createTagDefinitionMap();
    const prefix = createTagDefinitionListMap();
    for (const tag of compiledTags) {
      if (tag.nodeKind === "scalar" && tag.implicit) {
        if (tag.matchByTagPrefix) throw new Error("Implicit scalar tags cannot match by tag prefix");
        implicitScalarTags.push(tag);
      }
      switch (tag.nodeKind) {
        case "scalar":
          if (tag.matchByTagPrefix) prefix.scalar.push(tag);
          else exact.scalar[tag.tagName] = tag;
          break;
        case "sequence":
          if (tag.matchByTagPrefix) prefix.sequence.push(tag);
          else exact.sequence[tag.tagName] = tag;
          break;
        case "mapping":
          if (tag.matchByTagPrefix) prefix.mapping.push(tag);
          else exact.mapping[tag.tagName] = tag;
          break;
      }
    }
    const implicitScalarAnyFirstChar = implicitScalarTags.filter((tag) => tag.implicitFirstChars === null);
    const keys = /* @__PURE__ */ new Set();
    for (const tag of implicitScalarTags) if (tag.implicitFirstChars !== null) for (const key of tag.implicitFirstChars) keys.add(key);
    const implicitScalarByFirstChar = /* @__PURE__ */ new Map();
    for (const key of keys) implicitScalarByFirstChar.set(key, implicitScalarTags.filter((tag) => tag.implicitFirstChars === null || tag.implicitFirstChars.indexOf(key) !== -1));
    const defaultScalarTag = exact.scalar["tag:yaml.org,2002:str"];
    if (!defaultScalarTag) throw new Error("schema does not define the default scalar tag (tag:yaml.org,2002:str)");
    this.tags = compiledTags;
    this.implicitScalarTags = implicitScalarTags;
    this.implicitScalarByFirstChar = implicitScalarByFirstChar;
    this.implicitScalarAnyFirstChar = implicitScalarAnyFirstChar;
    this.defaultScalarTag = defaultScalarTag;
    this.defaultSequenceTag = exact.sequence["tag:yaml.org,2002:seq"];
    this.defaultMappingTag = exact.mapping["tag:yaml.org,2002:map"];
    this.exact = exact;
    this.prefix = prefix;
  }
  /** @internal */
  lookupScalarTag(tagName) {
    const exactTag = this.exact.scalar[tagName];
    if (exactTag) return exactTag;
    for (const tag of this.prefix.scalar) if (tagName.startsWith(tag.tagName)) return tag;
  }
  /** @internal */
  lookupSequenceTag(tagName) {
    const exactTag = this.exact.sequence[tagName];
    if (exactTag) return exactTag;
    for (const tag of this.prefix.sequence) if (tagName.startsWith(tag.tagName)) return tag;
  }
  /** @internal */
  lookupMappingTag(tagName) {
    const exactTag = this.exact.mapping[tagName];
    if (exactTag) return exactTag;
    for (const tag of this.prefix.mapping) if (tagName.startsWith(tag.tagName)) return tag;
  }
  /** @internal */
  resolveImplicitScalarTag(source) {
    const candidates = this.implicitScalarByFirstChar.get(source.charAt(0)) ?? this.implicitScalarAnyFirstChar;
    for (const tag2 of candidates) {
      const value = tag2.resolve(source, false, tag2.tagName);
      if (value !== NOT_RESOLVED) return {
        value,
        tag: tag2
      };
    }
    const tag = this.defaultScalarTag;
    return {
      value: tag.resolve(source, false, tag.tagName),
      tag
    };
  }
  /**
  * Creates a new schema with the specified tags added. If a tag already
  * exists, it is replaced by the specified tag.
  *
  * @example
  *
  * ```javascript
  * import { CORE_SCHEMA, mergeTag, realMapTag } from 'js-yaml'
  *
  * const schema = CORE_SCHEMA.withTags(mergeTag, realMapTag)
  * ```
  */
  withTags(...tags) {
    let flatTags = [];
    for (const tag of tags) flatTags = flatTags.concat(tag);
    return new Schema2([...this.tags, ...flatTags]);
  }
};
var FAILSAFE_SCHEMA = new Schema([
  strTag,
  seqTag,
  mapTag
]);
var JSON_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullJsonTag,
  boolJsonTag,
  intJsonTag,
  floatJsonTag
]);
var CORE_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullCoreTag,
  boolCoreTag,
  intCoreTag,
  floatCoreTag
]);
var YAML11_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullYaml11Tag,
  boolYaml11Tag,
  intYaml11Tag,
  floatYaml11Tag,
  timestampTag,
  mergeTag,
  binaryTag,
  omapTag,
  pairsTag,
  setTag
]);
var DUMP_SCHEMA = YAML11_SCHEMA.withTags({
  ...intYaml11Tag,
  resolve: (source, isExplicit, tagName) => {
    const result = intYaml11Tag.resolve(source, isExplicit, tagName);
    return result === NOT_RESOLVED ? intCoreTag.resolve(source, isExplicit, tagName) : result;
  }
}, {
  ...floatYaml11Tag,
  resolve: (source, isExplicit, tagName) => {
    const result = floatYaml11Tag.resolve(source, isExplicit, tagName);
    return result === NOT_RESOLVED ? floatCoreTag.resolve(source, isExplicit, tagName) : result;
  }
});
var realMapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => /* @__PURE__ */ new Map(),
  addPair: (container, key, value) => {
    container.set(key, value);
    return "";
  },
  has: (container, key) => container.has(key),
  keys: (container) => container.keys(),
  get: (container, key) => container.get(key),
  identify: (data) => data instanceof Map || isPlainObject(data),
  represent: (data) => {
    if (data instanceof Map) return data;
    const map = /* @__PURE__ */ new Map();
    const obj = data;
    for (const key of Object.keys(obj)) map.set(key, obj[key]);
    return map;
  }
});
function normalizeKey(key) {
  if (Array.isArray(key)) {
    const array = Array.prototype.slice.call(key);
    for (let index = 0; index < array.length; index++) {
      if (Array.isArray(array[index])) return null;
      if (typeof array[index] === "object" && Object.prototype.toString.call(array[index]) === "[object Object]") array[index] = "[object Object]";
    }
    return String(array);
  }
  if (typeof key === "object" && Object.prototype.toString.call(key) === "[object Object]") return "[object Object]";
  return String(key);
}
var legacyMapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => ({}),
  identify: isPlainObject,
  represent: (o) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of Object.keys(o)) map.set(key, o[key]);
    return map;
  },
  addPair: (container, key, value) => {
    const normalizedKey = normalizeKey(key);
    if (normalizedKey === null) return "nested arrays are not supported inside keys";
    if (normalizedKey === "__proto__") Object.defineProperty(container, normalizedKey, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    else container[normalizedKey] = value;
    return "";
  },
  has: (container, key) => {
    const normalizedKey = normalizeKey(key);
    return normalizedKey !== null && Object.prototype.hasOwnProperty.call(container, normalizedKey);
  },
  keys: (container) => Object.keys(container),
  get: (container, key) => {
    const normalizedKey = String(key);
    if (!Object.prototype.hasOwnProperty.call(container, normalizedKey)) return null;
    return container[normalizedKey];
  }
});
var DEFAULT_SNIPPET_OPTIONS = {
  maxLength: 79,
  indent: 1,
  linesBefore: 3,
  linesAfter: 2
};
function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
  let head = "";
  let tail = "";
  const maxHalfLength = Math.floor(maxLineLength / 2) - 1;
  if (position - lineStart > maxHalfLength) {
    head = " ... ";
    lineStart = position - maxHalfLength + head.length;
  }
  if (lineEnd - position > maxHalfLength) {
    tail = " ...";
    lineEnd = position + maxHalfLength - tail.length;
  }
  return {
    str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, "\u2192") + tail,
    pos: position - lineStart + head.length
  };
}
function padStart(string, max) {
  return " ".repeat(Math.max(max - string.length, 0)) + string;
}
function makeSnippet(mark, options) {
  if (!mark.buffer) return null;
  const opts = {
    ...DEFAULT_SNIPPET_OPTIONS,
    ...options
  };
  const re = /\r?\n|\r|\0/g;
  const lineStarts = [0];
  const lineEnds = [];
  let match;
  let foundLineNo = -1;
  while (match = re.exec(mark.buffer)) {
    lineEnds.push(match.index);
    lineStarts.push(match.index + match[0].length);
    if (mark.position <= match.index && foundLineNo < 0) foundLineNo = lineStarts.length - 2;
  }
  if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
  let result = "";
  const lineNoLength = Math.min(mark.line + opts.linesAfter, lineEnds.length).toString().length;
  const maxLineLength = opts.maxLength - (opts.indent + lineNoLength + 3);
  for (let i = 1; i <= opts.linesBefore; i++) {
    if (foundLineNo - i < 0) break;
    const line2 = getLine(mark.buffer, lineStarts[foundLineNo - i], lineEnds[foundLineNo - i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]), maxLineLength);
    result = `${" ".repeat(opts.indent)}${padStart((mark.line - i + 1).toString(), lineNoLength)} | ${line2.str}
${result}`;
  }
  const line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
  result += `${" ".repeat(opts.indent)}${padStart((mark.line + 1).toString(), lineNoLength)} | ${line.str}
`;
  result += `${"-".repeat(opts.indent + lineNoLength + 3 + line.pos)}^
`;
  for (let i = 1; i <= opts.linesAfter; i++) {
    if (foundLineNo + i >= lineEnds.length) break;
    const line2 = getLine(mark.buffer, lineStarts[foundLineNo + i], lineEnds[foundLineNo + i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]), maxLineLength);
    result += `${" ".repeat(opts.indent)}${padStart((mark.line + i + 1).toString(), lineNoLength)} | ${line2.str}
`;
  }
  return result.replace(/\n$/, "");
}
function formatError(exception, compact) {
  let where = "";
  if (!exception.mark) return exception.reason;
  if (exception.mark.name) where += `in "${exception.mark.name}" `;
  where += `(${exception.mark.line + 1}:${exception.mark.column + 1})`;
  if (!compact && exception.mark.snippet) where += `

${exception.mark.snippet}`;
  return `${exception.reason} ${where}`;
}
var YAMLException = class YAMLException2 extends Error {
  reason;
  mark;
  /**
  * Optional `mark` contains source snippet data. Usually, use
  * {@link YAMLException.throwAt} instead of passing it directly.
  */
  constructor(reason, mark) {
    super();
    this.name = "YAMLException";
    this.reason = reason;
    this.mark = mark;
    this.message = formatError(this, false);
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }
  /**
  * Returns the formatted error, omitting the source snippet in compact mode.
  */
  toString(compact) {
    return `${this.name}: ${formatError(this, compact)}`;
  }
  /**
  * Builds a YAMLException with a source snippet and throws it. `source` is
  * the raw input text; `position` is an offset into it.
  */
  static throwAt(source, position, message, filename = "") {
    let line = 0;
    let lineStart = 0;
    for (let index = 0; index < position; index++) {
      const ch = source.charCodeAt(index);
      if (ch === 10) {
        line++;
        lineStart = index + 1;
      } else if (ch === 13) {
        line++;
        if (source.charCodeAt(index + 1) === 10) index++;
        lineStart = index + 1;
      }
    }
    const mark = {
      name: filename,
      buffer: source,
      position,
      line,
      column: position - lineStart
    };
    mark.snippet = makeSnippet(mark);
    throw new YAMLException2(message, mark);
  }
};
var EVENT_ID = {
  DOCUMENT: 1,
  SEQUENCE: 2,
  MAPPING: 3,
  SCALAR: 4,
  ALIAS: 5,
  POP: 6
};
var SCALAR_STYLE = {
  PLAIN: 1,
  SINGLE_QUOTED: 2,
  DOUBLE_QUOTED: 3,
  LITERAL_BLOCK: 4,
  FOLDED_BLOCK: 5
};
var COLLECTION_STYLE = {
  BLOCK: 1,
  FLOW: 2
};
var CHOMPING_MODE = {
  CLIP: 1,
  STRIP: 2,
  KEEP: 3
};
var NO_RANGE$3 = -1;
function simpleEscapeSequence(c) {
  switch (c) {
    case 48:
      return "\0";
    case 97:
      return "\x07";
    case 98:
      return "\b";
    case 116:
      return "	";
    case 9:
      return "	";
    case 110:
      return "\n";
    case 118:
      return "\v";
    case 102:
      return "\f";
    case 114:
      return "\r";
    case 101:
      return "\x1B";
    case 32:
      return " ";
    case 34:
      return '"';
    case 47:
      return "/";
    case 92:
      return "\\";
    case 78:
      return "\x85";
    case 95:
      return "\xA0";
    case 76:
      return "\u2028";
    case 80:
      return "\u2029";
    default:
      return "";
  }
}
var simpleEscapeCheck = new Array(256);
var simpleEscapeMap = new Array(256);
for (let i = 0; i < 256; i++) {
  simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
  simpleEscapeMap[i] = simpleEscapeSequence(i);
}
function charFromCodepoint(c) {
  if (c <= 65535) return String.fromCharCode(c);
  return String.fromCharCode((c - 65536 >> 10) + 55296, (c - 65536 & 1023) + 56320);
}
function fromHexCode$1(c) {
  if (c >= 48 && c <= 57) return c - 48;
  return (c | 32) - 97 + 10;
}
function escapedHexLen$1(c) {
  if (c === 120) return 2;
  if (c === 117) return 4;
  return 8;
}
function skipFoldedBreaks(input, position, end) {
  let breaks = 0;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 10) {
      breaks++;
      position++;
    } else if (ch === 13) {
      breaks++;
      position++;
      if (input.charCodeAt(position) === 10) position++;
    } else if (ch === 32 || ch === 9) position++;
    else break;
  }
  return {
    position,
    breaks
  };
}
function foldedBreaks(count) {
  if (count === 1) return " ";
  return "\n".repeat(count - 1);
}
function getPlainValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, captureEnd);
}
function getSingleQuotedValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 39) {
      result += input.slice(captureStart, position) + "'";
      position += 2;
      captureStart = captureEnd = position;
    } else if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, end);
}
function getDoubleQuotedValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 92) {
      result += input.slice(captureStart, position);
      position++;
      const escaped = input.charCodeAt(position);
      if (escaped === 10 || escaped === 13) position = skipFoldedBreaks(input, position, end).position;
      else if (escaped < 256 && simpleEscapeCheck[escaped]) {
        result += simpleEscapeMap[escaped];
        position++;
      } else {
        let hexLength = escapedHexLen$1(escaped);
        let hexResult = 0;
        for (; hexLength > 0; hexLength--) {
          position++;
          const digit = fromHexCode$1(input.charCodeAt(position));
          hexResult = (hexResult << 4) + digit;
        }
        result += charFromCodepoint(hexResult);
        position++;
      }
      captureStart = captureEnd = position;
    } else if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, end);
}
function getBlockValue(input, start, end, indent, chomping, folded) {
  const textIndent = indent < 0 ? 0 : indent;
  const region = input.slice(start, end).replace(/\r\n?/g, "\n");
  const lines = region === "" ? [] : (region.endsWith("\n") ? region.slice(0, -1) : region).split("\n");
  let result = "";
  let didReadContent = false;
  let emptyLines = 0;
  let atMoreIndented = false;
  for (const line of lines) {
    let column = 0;
    while (column < textIndent && line.charCodeAt(column) === 32) column++;
    if (indent < 0 || column >= line.length) {
      emptyLines++;
      continue;
    }
    const content = line.slice(textIndent);
    const first = content.charCodeAt(0);
    if (folded) if (first === 32 || first === 9) {
      atMoreIndented = true;
      result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
    } else if (atMoreIndented) {
      atMoreIndented = false;
      result += "\n".repeat(emptyLines + 1);
    } else if (emptyLines === 0) {
      if (didReadContent) result += " ";
    } else result += "\n".repeat(emptyLines);
    else result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
    result += content;
    didReadContent = true;
    emptyLines = 0;
  }
  if (chomping === CHOMPING_MODE.KEEP) result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
  else if (chomping !== CHOMPING_MODE.STRIP) {
    if (didReadContent) result += "\n";
  }
  return result;
}
function getScalarValue(input, scalar) {
  if (scalar.valueStart === NO_RANGE$3) return "";
  const { valueStart, valueEnd } = scalar;
  if (scalar.fast) return input.slice(valueStart, valueEnd);
  switch (scalar.style) {
    case SCALAR_STYLE.SINGLE_QUOTED:
      return getSingleQuotedValue(input, valueStart, valueEnd);
    case SCALAR_STYLE.DOUBLE_QUOTED:
      return getDoubleQuotedValue(input, valueStart, valueEnd);
    case SCALAR_STYLE.LITERAL_BLOCK:
      return getBlockValue(input, valueStart, valueEnd, scalar.indent, scalar.chomping, false);
    case SCALAR_STYLE.FOLDED_BLOCK:
      return getBlockValue(input, valueStart, valueEnd, scalar.indent, scalar.chomping, true);
    default:
      return getPlainValue(input, valueStart, valueEnd);
  }
}
var DEFAULT_TAG_HANDLERS = Object.assign(/* @__PURE__ */ Object.create(null), {
  "!": "!",
  "!!": "tag:yaml.org,2002:"
});
function tagNameFull(rawTag, tagHandlers) {
  if (rawTag.startsWith("!<") && rawTag.endsWith(">")) return decodeURIComponent(rawTag.slice(2, -1));
  const handleEnd = rawTag.indexOf("!", 1);
  const handle = handleEnd === -1 ? "!" : rawTag.slice(0, handleEnd + 1);
  const prefix = tagHandlers?.[handle] ?? DEFAULT_TAG_HANDLERS[handle] ?? handle;
  return decodeURIComponent(prefix) + decodeURIComponent(rawTag.slice(handle.length));
}
var NO_RANGE$2 = -1;
var MERGE_TAG_NAME = "tag:yaml.org,2002:merge";
var DEFAULT_CONSTRUCTOR_OPTIONS = {
  filename: "",
  schema: CORE_SCHEMA,
  json: false,
  maxTotalMergeKeys: 1e4,
  maxAliases: -1
};
function eventPosition$1(event) {
  if ("tagStart" in event && event.tagStart !== NO_RANGE$2) return event.tagStart;
  if ("anchorStart" in event && event.anchorStart !== NO_RANGE$2) return event.anchorStart;
  if ("valueStart" in event && event.valueStart !== NO_RANGE$2) return event.valueStart;
  if ("start" in event) return event.start;
  return 0;
}
function throwError$1(state, message) {
  YAMLException.throwAt(state.source, state.position, message, state.filename);
}
function finalizeCollection(state, position, tag, carrier) {
  try {
    return tag.finalize(carrier);
  } catch (error) {
    if (error instanceof YAMLException) throw error;
    YAMLException.throwAt(state.source, position, error instanceof Error ? error.message : String(error), state.filename);
  }
}
function constructScalar(state, event) {
  const source = getScalarValue(state.source, event);
  const rawTag = event.tagStart === NO_RANGE$2 ? "" : state.source.slice(event.tagStart, event.tagEnd);
  const strTag2 = state.schema.defaultScalarTag;
  if (rawTag !== "") {
    if (rawTag === "!") return {
      value: source,
      tag: strTag2
    };
    const tagName = tagNameFull(rawTag, state.tagHandlers);
    const scalarTag = state.schema.lookupScalarTag(tagName);
    if (scalarTag) {
      const result = scalarTag.resolve(source, true, tagName);
      if (result === NOT_RESOLVED) throwError$1(state, `cannot resolve a node with !<${tagName}> explicit tag`);
      return {
        value: result,
        tag: scalarTag
      };
    }
    const collectionTagDef = state.schema.lookupMappingTag(tagName) ?? state.schema.lookupSequenceTag(tagName);
    if (collectionTagDef) {
      if (source !== "") throwError$1(state, `cannot resolve a node with !<${tagName}> explicit tag`);
      const carrier = collectionTagDef.create(tagName);
      return {
        value: collectionTagDef.carrierIsResult ? carrier : finalizeCollection(state, state.position, collectionTagDef, carrier),
        tag: collectionTagDef
      };
    }
    throwError$1(state, `unknown scalar tag !<${tagName}>`);
  }
  if (event.style === SCALAR_STYLE.PLAIN) return state.schema.resolveImplicitScalarTag(source);
  return {
    value: strTag2.resolve(source, false, strTag2.tagName),
    tag: strTag2
  };
}
function collectionTagName(state, event, defaultTagName) {
  const rawTag = event.tagStart === NO_RANGE$2 ? "" : state.source.slice(event.tagStart, event.tagEnd);
  return rawTag === "" || rawTag === "!" ? defaultTagName : tagNameFull(rawTag, state.tagHandlers);
}
function isMappingTag(tag) {
  return tag.nodeKind === "mapping";
}
function chargeMergeWork(state) {
  state.totalMergeKeys++;
  if (state.maxTotalMergeKeys !== -1 && state.totalMergeKeys > state.maxTotalMergeKeys) throwError$1(state, `merge keys exceeded maxTotalMergeKeys (${state.maxTotalMergeKeys})`);
}
function mergeKeys(state, frame, source, sourceTag) {
  chargeMergeWork(state);
  for (const sourceKey of sourceTag.keys(source)) {
    chargeMergeWork(state);
    if (frame.tag.has(frame.value, sourceKey)) continue;
    const err2 = frame.tag.addPair(frame.value, sourceKey, sourceTag.get(source, sourceKey));
    if (err2) throwError$1(state, err2);
    frame.overridable ??= /* @__PURE__ */ new Set();
    frame.overridable.add(sourceKey);
  }
}
function mergeSource(state, frame, source, sourceTag) {
  state.position = frame.keyPosition;
  if (isMappingTag(sourceTag)) mergeKeys(state, frame, source, sourceTag);
  else if (sourceTag.nodeKind === "sequence" && Array.isArray(source)) {
    if (source.length > 100) throwError$1(state, "abnormal merge sequence size");
    for (const element of source) {
      const elementTag = state.nodeTags.get(element);
      if (!elementTag) throwError$1(state, "cannot merge mappings; the provided source object is unacceptable");
      mergeKeys(state, frame, element, elementTag);
    }
  } else throwError$1(state, "cannot merge mappings; the provided source object is unacceptable");
}
function addMappingValue(state, frame, key, value, tag) {
  state.position = frame.keyPosition;
  if (frame.keyIsMerge) {
    mergeSource(state, frame, value, tag);
    return;
  }
  if (!state.json && frame.tag.has(frame.value, key) && !frame.overridable?.has(key)) throwError$1(state, "duplicated mapping key");
  const err2 = frame.tag.addPair(frame.value, key, value);
  if (err2) throwError$1(state, err2);
  frame.overridable?.delete(key);
}
function addValue(state, value, tag) {
  const frame = state.frames[state.frames.length - 1];
  if (frame.kind === "document") {
    frame.value = value;
    frame.hasValue = true;
  } else if (frame.kind === "sequence") {
    if (isMappingTag(tag)) state.nodeTags.set(value, tag);
    const err2 = frame.tag.addItem(frame.value, value, frame.index++);
    if (err2) throwError$1(state, err2);
  } else if (frame.hasKey) {
    const key = frame.key;
    frame.key = void 0;
    frame.hasKey = false;
    addMappingValue(state, frame, key, value, tag);
  } else {
    frame.key = value;
    frame.keyPosition = state.position;
    frame.hasKey = true;
    frame.keyIsMerge = tag.tagName === MERGE_TAG_NAME;
  }
}
function storeAnchor(state, event, value, tag, isValueFinal) {
  if (event.anchorStart !== NO_RANGE$2) {
    const anchor = {
      value,
      tag,
      isValueFinal
    };
    state.anchors.set(state.source.slice(event.anchorStart, event.anchorEnd), anchor);
    return anchor;
  }
  return null;
}
function constructFromEvents(events, options) {
  const state = {
    ...DEFAULT_CONSTRUCTOR_OPTIONS,
    ...options,
    events,
    documents: [],
    eventIndex: 0,
    position: 0,
    frames: [],
    anchors: /* @__PURE__ */ new Map(),
    nodeTags: /* @__PURE__ */ new Map(),
    tagHandlers: /* @__PURE__ */ Object.create(null),
    totalMergeKeys: 0,
    aliasCount: 0
  };
  while (state.eventIndex < state.events.length) {
    const event = state.events[state.eventIndex++];
    state.position = eventPosition$1(event);
    switch (event.type) {
      case EVENT_ID.DOCUMENT:
        state.anchors = /* @__PURE__ */ new Map();
        state.nodeTags = /* @__PURE__ */ new Map();
        state.aliasCount = 0;
        state.tagHandlers = /* @__PURE__ */ Object.create(null);
        for (const directive of event.directives) if (directive.kind === "tag") state.tagHandlers[directive.handle] = directive.prefix;
        state.frames.push({
          kind: "document",
          position: state.position,
          value: void 0,
          hasValue: false
        });
        break;
      case EVENT_ID.SCALAR: {
        const { value, tag } = constructScalar(state, event);
        storeAnchor(state, event, value, tag, true);
        addValue(state, value, tag);
        break;
      }
      case EVENT_ID.SEQUENCE: {
        const tagName = collectionTagName(state, event, "tag:yaml.org,2002:seq");
        const tag = state.schema.lookupSequenceTag(tagName);
        if (!tag) throwError$1(state, `unknown sequence tag !<${tagName}>`);
        const value = tag.create(tagName);
        const anchor = storeAnchor(state, event, value, tag, tag.carrierIsResult);
        state.frames.push({
          kind: "sequence",
          position: state.position,
          value,
          tag,
          anchor,
          index: 0
        });
        break;
      }
      case EVENT_ID.MAPPING: {
        const tagName = collectionTagName(state, event, "tag:yaml.org,2002:map");
        const tag = state.schema.lookupMappingTag(tagName);
        if (!tag) throwError$1(state, `unknown mapping tag !<${tagName}>`);
        const value = tag.create(tagName);
        const anchor = storeAnchor(state, event, value, tag, tag.carrierIsResult);
        state.frames.push({
          kind: "mapping",
          position: state.position,
          value,
          tag,
          anchor,
          key: void 0,
          keyPosition: state.position,
          hasKey: false,
          keyIsMerge: false,
          overridable: null
        });
        break;
      }
      case EVENT_ID.ALIAS: {
        if (state.maxAliases !== -1 && ++state.aliasCount > state.maxAliases) throwError$1(state, `aliases exceeded maxAliases (${state.maxAliases})`);
        const name = state.source.slice(event.anchorStart, event.anchorEnd);
        const anchor = state.anchors.get(name);
        if (!anchor) throwError$1(state, `unidentified alias "${name}"`);
        if (!anchor.isValueFinal) throwError$1(state, `recursive alias "${name}" is not supported for tag ${anchor.tag.tagName} because it uses finalize()`);
        addValue(state, anchor.value, anchor.tag);
        break;
      }
      case EVENT_ID.POP: {
        const frame = state.frames.pop();
        if (frame.kind === "mapping" && frame.hasKey) {
          state.position = frame.keyPosition;
          throwError$1(state, "incomplete mapping pair in event stream");
        }
        if (frame.kind === "document") state.documents.push(frame.value);
        else {
          const value = frame.tag.carrierIsResult ? frame.value : finalizeCollection(state, frame.position, frame.tag, frame.value);
          if (frame.anchor) {
            frame.anchor.value = value;
            frame.anchor.isValueFinal = true;
          }
          addValue(state, value, frame.tag);
        }
        break;
      }
    }
  }
  return state.documents;
}
var NO_RANGE$1 = -1;
var HAS_OWN = Object.prototype.hasOwnProperty;
var CONTEXT_FLOW_IN = 1;
var CONTEXT_FLOW_OUT = 2;
var CONTEXT_BLOCK_IN = 3;
var CONTEXT_BLOCK_OUT = 4;
var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
var PATTERN_FLOW_INDICATORS = /[,\[\]{}]/;
var PATTERN_TAG_HANDLE = /^(?:!|!!|![0-9A-Za-z-]+!)$/;
var NS_URI_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[0-9A-Za-z\-#;/?:@&=+$,_.!~*'()\[\]])`;
var NS_TAG_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[0-9A-Za-z\-#;/?:@&=+$.~*'()_])`;
var PATTERN_TAG_URI = new RegExp(`^(?:${NS_URI_CHAR})*$`);
var PATTERN_TAG_SUFFIX = new RegExp(`^(?:${NS_TAG_CHAR})+$`);
var PATTERN_TAG_PREFIX = new RegExp(`^(?:!(?:${NS_URI_CHAR})*|${NS_TAG_CHAR}(?:${NS_URI_CHAR})*)$`);
var DEFAULT_PARSER_OPTIONS = {
  filename: "",
  maxDepth: 100
};
function addDocumentEvent(state, explicitStart, explicitEnd) {
  state.events.push({
    type: EVENT_ID.DOCUMENT,
    explicitStart,
    explicitEnd,
    directives: state.directives
  });
}
function addSequenceEvent(state, start, anchorStart, anchorEnd, tagStart, tagEnd, style) {
  state.events.push({
    type: EVENT_ID.SEQUENCE,
    start,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style
  });
}
function addMappingEvent(state, start, anchorStart, anchorEnd, tagStart, tagEnd, style) {
  state.events.push({
    type: EVENT_ID.MAPPING,
    start,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style
  });
}
function insertFlowPairMappingEvent(state, snapshot) {
  state.events.splice(snapshot.eventsLength, 0, {
    type: EVENT_ID.MAPPING,
    start: snapshot.position,
    anchorStart: NO_RANGE$1,
    anchorEnd: NO_RANGE$1,
    tagStart: NO_RANGE$1,
    tagEnd: NO_RANGE$1,
    style: COLLECTION_STYLE.FLOW
  });
}
function addScalarEvent(state, valueStart, valueEnd, anchorStart, anchorEnd, tagStart, tagEnd, style, chomping = CHOMPING_MODE.CLIP, indent = -1, fast = false) {
  state.events.push({
    type: EVENT_ID.SCALAR,
    valueStart,
    valueEnd,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style,
    chomping,
    indent,
    fast
  });
}
function addAliasEvent(state, anchorStart, anchorEnd) {
  state.events.push({
    type: EVENT_ID.ALIAS,
    anchorStart,
    anchorEnd
  });
}
function addPopEvent(state) {
  state.events.push({ type: EVENT_ID.POP });
}
function addEmptyScalarEvent(state) {
  addScalarEvent(state, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, SCALAR_STYLE.PLAIN);
}
function emptyProperties() {
  return {
    anchorStart: NO_RANGE$1,
    anchorEnd: NO_RANGE$1,
    tagStart: NO_RANGE$1,
    tagEnd: NO_RANGE$1
  };
}
function snapshotState(state) {
  return {
    position: state.position,
    line: state.line,
    lineStart: state.lineStart,
    lineIndent: state.lineIndent,
    firstTabInLine: state.firstTabInLine,
    eventsLength: state.events.length
  };
}
function restoreState(state, snapshot) {
  state.position = snapshot.position;
  state.line = snapshot.line;
  state.lineStart = snapshot.lineStart;
  state.lineIndent = snapshot.lineIndent;
  state.firstTabInLine = snapshot.firstTabInLine;
  state.events.length = snapshot.eventsLength;
}
function throwError(state, message) {
  YAMLException.throwAt(state.input.slice(0, state.length), state.position, message, state.filename);
}
function isEol(c) {
  return c === 10 || c === 13;
}
function isWhiteSpace(c) {
  return c === 9 || c === 32;
}
function isWsOrEol(c) {
  return isWhiteSpace(c) || isEol(c);
}
function isWsOrEolOrEnd(c) {
  return c === 0 || isWsOrEol(c);
}
function isFlowIndicator(c) {
  return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
}
function fromDecimalCode(c) {
  return c >= 48 && c <= 57 ? c - 48 : -1;
}
function fromHexCode(c) {
  if (c >= 48 && c <= 57) return c - 48;
  const lc = c | 32;
  if (lc >= 97 && lc <= 102) return lc - 97 + 10;
  return -1;
}
function escapedHexLen(c) {
  if (c === 120) return 2;
  if (c === 117) return 4;
  if (c === 85) return 8;
  return 0;
}
function isSimpleEscape(c) {
  return c === 48 || c === 97 || c === 98 || c === 116 || c === 9 || c === 110 || c === 118 || c === 102 || c === 114 || c === 101 || c === 32 || c === 34 || c === 47 || c === 92 || c === 78 || c === 95 || c === 76 || c === 80;
}
function consumeLineBreak(state) {
  if (state.input.charCodeAt(state.position) === 10) state.position++;
  else {
    state.position++;
    if (state.input.charCodeAt(state.position) === 10) state.position++;
  }
  state.line++;
  state.lineStart = state.position;
  state.lineIndent = 0;
  state.firstTabInLine = -1;
}
function skipSeparationSpace(state, allowComments) {
  let lineBreaks = 0;
  let ch = state.input.charCodeAt(state.position);
  let hasSeparation = state.position === state.lineStart || isWsOrEol(state.input.charCodeAt(state.position - 1));
  while (ch !== 0) {
    while (isWhiteSpace(ch)) {
      hasSeparation = true;
      if (ch === 9 && state.firstTabInLine === -1) state.firstTabInLine = state.position;
      ch = state.input.charCodeAt(++state.position);
    }
    if (allowComments && hasSeparation && ch === 35) do
      ch = state.input.charCodeAt(++state.position);
    while (!isEol(ch) && ch !== 0);
    if (!isEol(ch)) break;
    consumeLineBreak(state);
    lineBreaks++;
    hasSeparation = true;
    ch = state.input.charCodeAt(state.position);
    while (ch === 32) {
      state.lineIndent++;
      ch = state.input.charCodeAt(++state.position);
    }
  }
  return lineBreaks;
}
function testDocumentSeparator(state, position = state.position) {
  const ch = state.input.charCodeAt(position);
  if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(position + 1) && ch === state.input.charCodeAt(position + 2)) {
    const following = state.input.charCodeAt(position + 3);
    return following === 0 || isWsOrEol(following);
  }
  return false;
}
function skipByteOrderMark(state) {
  if (state.position === state.lineStart && state.input.charCodeAt(state.position) === 65279) {
    state.position++;
    state.lineStart = state.position;
  }
}
function testDocumentBoundary(state) {
  if (state.position !== state.lineStart) return false;
  if (testDocumentSeparator(state)) return true;
  if (state.input.charCodeAt(state.position) !== 65279) return false;
  const snapshot = snapshotState(state);
  skipByteOrderMark(state);
  skipSeparationSpace(state, true);
  const ch = state.input.charCodeAt(state.position);
  const result = state.position === state.lineStart && (ch === 37 || ch === 45 && testDocumentSeparator(state));
  restoreState(state, snapshot);
  return result;
}
function skipUntilLineEnd(state) {
  let ch = state.input.charCodeAt(state.position);
  while (ch !== 0 && !isEol(ch)) ch = state.input.charCodeAt(++state.position);
}
function checkPrintable(state, start, end) {
  if (PATTERN_NON_PRINTABLE.test(state.input.slice(start, end))) throwError(state, "the stream contains non-printable characters");
}
function readTagProperty(state, props, inFlow) {
  if (state.input.charCodeAt(state.position) !== 33) return false;
  if (props.tagStart !== NO_RANGE$1) throwError(state, "duplication of a tag property");
  const start = state.position;
  let isVerbatim = false;
  let isNamed = false;
  let tagHandle = "!";
  let ch = state.input.charCodeAt(++state.position);
  if (ch === 60) {
    isVerbatim = true;
    ch = state.input.charCodeAt(++state.position);
  } else if (ch === 33) {
    isNamed = true;
    tagHandle = "!!";
    ch = state.input.charCodeAt(++state.position);
  }
  let suffixStart = state.position;
  let tagName;
  if (isVerbatim) {
    while (ch !== 0 && ch !== 62) ch = state.input.charCodeAt(++state.position);
    if (ch !== 62) throwError(state, "unexpected end of the stream within a verbatim tag");
    tagName = state.input.slice(suffixStart, state.position);
    state.position++;
  } else {
    while (ch !== 0 && !isWsOrEol(ch) && !(inFlow && isFlowIndicator(ch))) {
      if (ch === 33) if (!isNamed) {
        tagHandle = state.input.slice(suffixStart - 1, state.position + 1);
        if (!PATTERN_TAG_HANDLE.test(tagHandle)) throwError(state, "named tag handle cannot contain such characters");
        isNamed = true;
        suffixStart = state.position + 1;
      } else throwError(state, "tag suffix cannot contain exclamation marks");
      ch = state.input.charCodeAt(++state.position);
    }
    tagName = state.input.slice(suffixStart, state.position);
    if (PATTERN_FLOW_INDICATORS.test(tagName)) throwError(state, "tag suffix cannot contain flow indicator characters");
  }
  if (tagName && !(isVerbatim ? PATTERN_TAG_URI.test(tagName) : PATTERN_TAG_SUFFIX.test(tagName))) throwError(state, `tag name cannot contain such characters: ${tagName}`);
  if (!isVerbatim && tagHandle !== "!" && tagHandle !== "!!" && !HAS_OWN.call(state.tagHandlers, tagHandle)) throwError(state, `undeclared tag handle "${tagHandle}"`);
  props.tagStart = start;
  props.tagEnd = state.position;
  return true;
}
function readAnchorProperty(state, props) {
  if (state.input.charCodeAt(state.position) !== 38) return false;
  if (props.anchorStart !== NO_RANGE$1) throwError(state, "duplication of an anchor property");
  state.position++;
  const start = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position)) && !isFlowIndicator(state.input.charCodeAt(state.position))) state.position++;
  if (state.position === start) throwError(state, "name of an anchor node must contain at least one character");
  props.anchorStart = start;
  props.anchorEnd = state.position;
  return true;
}
function readAlias(state, props) {
  if (state.input.charCodeAt(state.position) !== 42) return false;
  if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) throwError(state, "alias node should not have any properties");
  state.position++;
  const start = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position)) && !isFlowIndicator(state.input.charCodeAt(state.position))) state.position++;
  if (state.position === start) throwError(state, "name of an alias node must contain at least one character");
  addAliasEvent(state, start, state.position);
  return true;
}
function readFlowScalarBreak(state, nodeIndent) {
  skipSeparationSpace(state, false);
  if (state.lineIndent < nodeIndent) throwError(state, "deficient indentation");
}
function readSingleQuotedScalar(state, nodeIndent, props) {
  if (state.input.charCodeAt(state.position) !== 39) return false;
  state.position++;
  const start = state.position;
  let simple = true;
  while (state.input.charCodeAt(state.position) !== 0) {
    const ch = state.input.charCodeAt(state.position);
    if (ch === 39) {
      if (state.input.charCodeAt(state.position + 1) === 39) {
        simple = false;
        state.position += 2;
        continue;
      }
      const end = state.position;
      state.position++;
      addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.SINGLE_QUOTED, CHOMPING_MODE.CLIP, -1, simple);
      return true;
    }
    if (isEol(ch)) {
      simple = false;
      readFlowScalarBreak(state, nodeIndent);
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a single quoted scalar");
    else if (ch !== 9 && ch < 32) throwError(state, "expected valid JSON character");
    else state.position++;
  }
  throwError(state, "unexpected end of the stream within a single quoted scalar");
}
function readDoubleQuotedScalar(state, nodeIndent, props) {
  if (state.input.charCodeAt(state.position) !== 34) return false;
  state.position++;
  const start = state.position;
  let simple = true;
  while (state.input.charCodeAt(state.position) !== 0) {
    const ch = state.input.charCodeAt(state.position);
    if (ch === 34) {
      const end = state.position;
      state.position++;
      addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.DOUBLE_QUOTED, CHOMPING_MODE.CLIP, -1, simple);
      return true;
    }
    if (ch === 92) {
      simple = false;
      const escaped = state.input.charCodeAt(++state.position);
      if (isEol(escaped)) readFlowScalarBreak(state, nodeIndent);
      else if (isSimpleEscape(escaped)) state.position++;
      else {
        let hexLength = escapedHexLen(escaped);
        if (hexLength === 0) throwError(state, "unknown escape sequence");
        while (hexLength-- > 0) {
          state.position++;
          if (fromHexCode(state.input.charCodeAt(state.position)) < 0) throwError(state, "expected hexadecimal character");
        }
        state.position++;
      }
    } else if (isEol(ch)) {
      simple = false;
      readFlowScalarBreak(state, nodeIndent);
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a double quoted scalar");
    else if (ch !== 9 && ch < 32) throwError(state, "expected valid JSON character");
    else state.position++;
  }
  throwError(state, "unexpected end of the stream within a double quoted scalar");
}
function readBlockScalar(state, parentIndent, props) {
  const ch = state.input.charCodeAt(state.position);
  let chomping = CHOMPING_MODE.CLIP;
  let indent = -1;
  let detectedIndent = false;
  if (ch !== 124 && ch !== 62) return false;
  const style = ch === 124 ? SCALAR_STYLE.LITERAL_BLOCK : SCALAR_STYLE.FOLDED_BLOCK;
  state.position++;
  while (state.input.charCodeAt(state.position) !== 0) {
    const current = state.input.charCodeAt(state.position);
    const digit = fromDecimalCode(current);
    if (current === 43 || current === 45) {
      if (chomping !== CHOMPING_MODE.CLIP) throwError(state, "repeat of a chomping mode identifier");
      chomping = current === 43 ? CHOMPING_MODE.KEEP : CHOMPING_MODE.STRIP;
      state.position++;
    } else if (digit >= 0) {
      if (digit === 0) throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
      if (detectedIndent) throwError(state, "repeat of an indentation width identifier");
      indent = parentIndent + digit - 1;
      detectedIndent = true;
      state.position++;
    } else break;
  }
  let hadWhitespace = false;
  while (isWhiteSpace(state.input.charCodeAt(state.position))) {
    hadWhitespace = true;
    state.position++;
  }
  if (hadWhitespace && state.input.charCodeAt(state.position) === 35) skipUntilLineEnd(state);
  if (isEol(state.input.charCodeAt(state.position))) consumeLineBreak(state);
  else if (state.input.charCodeAt(state.position) !== 0) throwError(state, "a line break is expected");
  let contentIndent = detectedIndent ? indent : -1;
  let maxLeadingIndent = 0;
  const valueStart = state.position;
  let valueEnd = state.position;
  while (state.input.charCodeAt(state.position) !== 0) {
    const linePosition = state.position;
    let column = 0;
    while (state.input.charCodeAt(linePosition + column) === 32) column++;
    const first = state.input.charCodeAt(linePosition + column);
    if (first === 0) {
      if (contentIndent >= 0) {
        if (column > contentIndent) valueEnd = linePosition + column;
      } else if (column > 0) valueEnd = linePosition + column;
      break;
    }
    if (testDocumentBoundary(state)) break;
    if (!detectedIndent && contentIndent === -1 && isEol(first)) maxLeadingIndent = Math.max(maxLeadingIndent, column);
    if (!detectedIndent && contentIndent === -1 && !isEol(first)) {
      if (first === 9 && column < parentIndent) {
        state.position = linePosition + column;
        throwError(state, "tab characters must not be used in indentation");
      }
      if (column < maxLeadingIndent) {
        state.position = linePosition + column;
        throwError(state, "bad indentation of a mapping entry");
      }
    }
    if (contentIndent === -1 && first !== 0 && !isEol(first) && column < parentIndent) {
      state.lineIndent = column;
      state.position = linePosition + column;
      break;
    }
    if (!detectedIndent && first !== 0 && !isEol(first) && contentIndent === -1) contentIndent = column;
    const requiredIndent = contentIndent === -1 ? parentIndent + 1 : contentIndent;
    if (first !== 0 && !isEol(first) && column < requiredIndent) {
      state.lineIndent = column;
      state.position = linePosition + column;
      break;
    }
    skipUntilLineEnd(state);
    valueEnd = state.position;
    if (isEol(state.input.charCodeAt(state.position))) {
      consumeLineBreak(state);
      valueEnd = state.position;
    }
  }
  checkPrintable(state, valueStart, valueEnd);
  addScalarEvent(state, valueStart, valueEnd, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, style, chomping, contentIndent);
  return true;
}
function canStartPlainScalar(state, nodeContext) {
  const ch = state.input.charCodeAt(state.position);
  const inFlow = nodeContext === CONTEXT_FLOW_IN;
  if (ch === 0 || isWsOrEol(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96 || inFlow && isFlowIndicator(ch)) return false;
  if (ch === 63 || ch === 45) {
    const following = state.input.charCodeAt(state.position + 1);
    if (isWsOrEolOrEnd(following) || inFlow && isFlowIndicator(following)) return false;
  }
  return true;
}
function readPlainScalar(state, nodeIndent, nodeContext, props) {
  if (!canStartPlainScalar(state, nodeContext)) return false;
  const start = state.position;
  let end = state.position;
  let ch = state.input.charCodeAt(state.position);
  const inFlow = nodeContext === CONTEXT_FLOW_IN;
  let multiline = false;
  while (ch !== 0) {
    if (testDocumentBoundary(state)) break;
    if (ch === 58) {
      const following = state.input.charCodeAt(state.position + 1);
      if (isWsOrEolOrEnd(following) || inFlow && isFlowIndicator(following)) break;
    } else if (ch === 35) {
      if (isWsOrEol(state.input.charCodeAt(state.position - 1))) break;
    } else if (inFlow && isFlowIndicator(ch)) break;
    else if (isEol(ch)) {
      const savedPosition = state.position;
      const savedLine = state.line;
      const savedLineStart = state.lineStart;
      const savedLineIndent = state.lineIndent;
      skipSeparationSpace(state, false);
      if (state.lineIndent >= nodeIndent) {
        multiline = true;
        ch = state.input.charCodeAt(state.position);
        continue;
      }
      state.position = savedPosition;
      state.line = savedLine;
      state.lineStart = savedLineStart;
      state.lineIndent = savedLineIndent;
      break;
    }
    if (!isWhiteSpace(ch)) end = state.position + 1;
    ch = state.input.charCodeAt(++state.position);
  }
  if (end === start) return false;
  checkPrintable(state, start, end);
  addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.PLAIN, CHOMPING_MODE.CLIP, -1, !multiline);
  return true;
}
function skipFlowSeparationSpace(state, nodeIndent) {
  const startLine = state.line;
  skipSeparationSpace(state, true);
  if (state.line > startLine && state.lineIndent < nodeIndent || state.firstTabInLine !== -1 && state.lineIndent < nodeIndent) throwError(state, "deficient indentation");
}
function readFlowCollection(state, nodeIndent, props) {
  const ch = state.input.charCodeAt(state.position);
  const isMapping = ch === 123;
  const start = state.position;
  let readNext = true;
  if (ch !== 91 && ch !== 123) return false;
  const terminator = isMapping ? 125 : 93;
  if (isMapping) addMappingEvent(state, start, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.FLOW);
  else addSequenceEvent(state, start, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.FLOW);
  state.position++;
  while (state.input.charCodeAt(state.position) !== 0) {
    skipFlowSeparationSpace(state, nodeIndent);
    let ch2 = state.input.charCodeAt(state.position);
    if (ch2 === terminator) {
      state.position++;
      addPopEvent(state);
      return true;
    } else if (!readNext) throwError(state, "missed comma between flow collection entries");
    else if (ch2 === 44) throwError(state, "expected the node content, but found ','");
    let isPair = false;
    let isExplicitPair = false;
    if (ch2 === 63 && isWsOrEol(state.input.charCodeAt(state.position + 1))) {
      isPair = isExplicitPair = true;
      state.position += 1;
      skipFlowSeparationSpace(state, nodeIndent);
    }
    const entryLine = state.line;
    const entryStart = snapshotState(state);
    const keyWasRead = parseNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
    skipFlowSeparationSpace(state, nodeIndent);
    ch2 = state.input.charCodeAt(state.position);
    if ((isMapping || isExplicitPair || state.line === entryLine) && ch2 === 58) {
      isPair = true;
      state.position++;
      skipFlowSeparationSpace(state, nodeIndent);
      if (!isMapping) {
        insertFlowPairMappingEvent(state, entryStart);
        if (!keyWasRead) addEmptyScalarEvent(state);
      } else if (!keyWasRead) addEmptyScalarEvent(state);
      if (!parseNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true)) addEmptyScalarEvent(state);
      skipFlowSeparationSpace(state, nodeIndent);
      if (!isMapping) addPopEvent(state);
    } else if (isMapping && isPair) {
      if (!keyWasRead) addEmptyScalarEvent(state);
      addEmptyScalarEvent(state);
    } else if (isMapping) addEmptyScalarEvent(state);
    else if (isPair) {
      insertFlowPairMappingEvent(state, entryStart);
      if (!keyWasRead) addEmptyScalarEvent(state);
      addEmptyScalarEvent(state);
      addPopEvent(state);
    }
    ch2 = state.input.charCodeAt(state.position);
    if (ch2 === 44) {
      readNext = true;
      state.position++;
    } else readNext = false;
  }
  throwError(state, "unexpected end of the stream within a flow collection");
}
function readBlockSequence(state, nodeIndent, props) {
  if (state.firstTabInLine !== -1 || state.input.charCodeAt(state.position) !== 45 || !isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) return false;
  addSequenceEvent(state, state.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
  while (state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) {
    if (state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    const entryLine = state.line;
    state.position++;
    const hadBreak = skipSeparationSpace(state, true) > 0;
    if (state.firstTabInLine !== -1 && state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) throwError(state, "bad indentation of a sequence entry");
    if (hadBreak && state.lineIndent <= nodeIndent) addEmptyScalarEvent(state);
    else parseNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
    skipSeparationSpace(state, true);
    if (state.lineIndent < nodeIndent || state.position >= state.length) break;
    if (state.lineIndent > nodeIndent) throwError(state, "bad indentation of a sequence entry");
    if (state.line === entryLine && state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) throwError(state, "bad indentation of a sequence entry");
  }
  addPopEvent(state);
  return true;
}
function readBlockMapping(state, nodeIndent, flowIndent, props) {
  let atExplicitKey = false;
  let detected = false;
  let mappingOpened = false;
  let pendingExplicitKey = false;
  if (state.firstTabInLine !== -1) return false;
  let ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (!atExplicitKey && state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    const following = state.input.charCodeAt(state.position + 1);
    const entryLine = state.line;
    if ((ch === 63 || ch === 58) && isWsOrEolOrEnd(following)) {
      if (!mappingOpened) {
        addMappingEvent(state, state.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
        mappingOpened = true;
      }
      if (ch === 63) {
        if (atExplicitKey) addEmptyScalarEvent(state);
        detected = true;
        atExplicitKey = true;
      } else if (atExplicitKey) atExplicitKey = false;
      else {
        addEmptyScalarEvent(state);
        detected = true;
        atExplicitKey = false;
      }
      state.position += 1;
      pendingExplicitKey = true;
    } else {
      if (atExplicitKey) {
        addEmptyScalarEvent(state);
        atExplicitKey = false;
      }
      const beforeKey = snapshotState(state);
      if (!parseNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) break;
      if (state.line === entryLine) {
        ch = state.input.charCodeAt(state.position);
        while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
        if (ch === 58) {
          ch = state.input.charCodeAt(++state.position);
          if (!isWsOrEolOrEnd(ch)) throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
          if (!mappingOpened) {
            restoreState(state, beforeKey);
            addMappingEvent(state, beforeKey.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
            mappingOpened = true;
            parseNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true);
            ch = state.input.charCodeAt(state.position);
            while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
            state.position++;
          }
          detected = true;
          atExplicitKey = false;
          pendingExplicitKey = false;
        } else if (detected) throwError(state, "expected ':' after a mapping key");
        else {
          if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) {
            restoreState(state, beforeKey);
            return false;
          }
          return true;
        }
      } else if (detected) throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
      else {
        if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) {
          restoreState(state, beforeKey);
          return false;
        }
        return true;
      }
    }
    if (parseNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, pendingExplicitKey)) pendingExplicitKey = false;
    if (!atExplicitKey) {
      if (pendingExplicitKey) {
        addEmptyScalarEvent(state);
        pendingExplicitKey = false;
      }
    }
    skipSeparationSpace(state, true);
    ch = state.input.charCodeAt(state.position);
    if ((state.line === entryLine || state.lineIndent > nodeIndent) && ch !== 0) throwError(state, "bad indentation of a mapping entry");
    else if (state.lineIndent < nodeIndent) break;
  }
  if (!detected) return false;
  if (atExplicitKey) addEmptyScalarEvent(state);
  if (mappingOpened) addPopEvent(state);
  return true;
}
function parseNode(state, parentIndent, nodeContext, allowToSeek, allowCompact, allowPropertyMapping = true) {
  if (state.depth >= state.maxDepth) throwError(state, `nesting exceeded maxDepth (${state.maxDepth})`);
  state.depth++;
  let indentStatus = 1;
  let atNewLine = false;
  let hasContent = false;
  let propertyStart = null;
  const props = emptyProperties();
  let allowBlockScalars = nodeContext === CONTEXT_BLOCK_OUT || nodeContext === CONTEXT_BLOCK_IN;
  let allowBlockCollections = allowBlockScalars;
  const allowBlockStyles = allowBlockScalars;
  if (allowToSeek && skipSeparationSpace(state, true)) {
    atNewLine = true;
    if (state.lineIndent > parentIndent) indentStatus = 1;
    else if (state.lineIndent === parentIndent) indentStatus = 0;
    else indentStatus = -1;
  }
  if (indentStatus === 1) while (true) {
    const ch = state.input.charCodeAt(state.position);
    const propertyState = snapshotState(state);
    if (atNewLine && indentStatus !== 1 && (ch === 33 || ch === 38)) break;
    if (atNewLine && allowBlockStyles && (props.tagStart !== NO_RANGE$1 || props.anchorStart !== NO_RANGE$1) && (ch === 33 || ch === 38)) {
      const fallbackState = snapshotState(state);
      const flowIndent = parentIndent + 1;
      if (readBlockMapping(state, state.position - state.lineStart, flowIndent, props) && state.events[fallbackState.eventsLength]?.type === EVENT_ID.MAPPING) {
        state.depth--;
        return true;
      }
      restoreState(state, fallbackState);
    }
    if (atNewLine && (ch === 33 && props.tagStart !== NO_RANGE$1 || ch === 38 && props.anchorStart !== NO_RANGE$1)) break;
    if (!readTagProperty(state, props, nodeContext === CONTEXT_FLOW_IN) && !readAnchorProperty(state, props)) break;
    if (propertyStart === null) propertyStart = propertyState;
    if (skipSeparationSpace(state, true)) {
      atNewLine = true;
      allowBlockCollections = allowBlockStyles;
      if (state.lineIndent > parentIndent) indentStatus = 1;
      else if (state.lineIndent === parentIndent) indentStatus = 0;
      else indentStatus = -1;
    } else allowBlockCollections = false;
  }
  if (allowBlockCollections) allowBlockCollections = atNewLine || allowCompact;
  if (indentStatus === 1 || nodeContext === CONTEXT_BLOCK_OUT) {
    const flowIndent = nodeContext === CONTEXT_FLOW_IN || nodeContext === CONTEXT_FLOW_OUT ? parentIndent : parentIndent + 1;
    const blockIndent = state.position - state.lineStart;
    if (indentStatus === 1) if (allowBlockCollections && (readBlockSequence(state, blockIndent, props) || readBlockMapping(state, blockIndent, flowIndent, props)) || readFlowCollection(state, flowIndent, props)) hasContent = true;
    else {
      const ch = state.input.charCodeAt(state.position);
      if (propertyStart !== null && allowPropertyMapping && allowBlockStyles && !allowBlockCollections && ch !== 124 && ch !== 62) {
        const fallbackState = snapshotState(state);
        const propertyIndent = propertyStart.position - propertyStart.lineStart;
        restoreState(state, propertyStart);
        if (readBlockMapping(state, propertyIndent, flowIndent, emptyProperties()) && state.events[fallbackState.eventsLength]?.type === EVENT_ID.MAPPING) hasContent = true;
        else restoreState(state, fallbackState);
      }
      if (!hasContent && (allowBlockScalars && readBlockScalar(state, flowIndent, props) || readSingleQuotedScalar(state, flowIndent, props) || readDoubleQuotedScalar(state, flowIndent, props) || readAlias(state, props) || readPlainScalar(state, flowIndent, nodeContext, props))) hasContent = true;
    }
    else if (indentStatus === 0) hasContent = allowBlockCollections && readBlockSequence(state, blockIndent, props);
  }
  allowBlockScalars = allowBlockScalars && !hasContent;
  if (!hasContent && (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1 || allowBlockScalars)) {
    addScalarEvent(state, NO_RANGE$1, NO_RANGE$1, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.PLAIN);
    hasContent = true;
  }
  state.depth--;
  return hasContent || props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1;
}
function readDirective(state) {
  if (state.lineIndent > 0 || state.input.charCodeAt(state.position) !== 37) return false;
  state.position++;
  const nameStart = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position))) state.position++;
  const name = state.input.slice(nameStart, state.position);
  const args = [];
  if (name.length === 0) throwError(state, "directive name must not be less than one character in length");
  while (state.input.charCodeAt(state.position) !== 0 && !isEol(state.input.charCodeAt(state.position))) {
    while (isWhiteSpace(state.input.charCodeAt(state.position))) state.position++;
    if (state.input.charCodeAt(state.position) === 35 || isEol(state.input.charCodeAt(state.position)) || state.input.charCodeAt(state.position) === 0) break;
    const start = state.position;
    while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position))) state.position++;
    args.push(state.input.slice(start, state.position));
  }
  if (isEol(state.input.charCodeAt(state.position))) consumeLineBreak(state);
  if (name === "YAML") {
    if (state.directives.some((directive) => directive.kind === "yaml")) throwError(state, "duplication of %YAML directive");
    if (args.length !== 1) throwError(state, "YAML directive accepts exactly one argument");
    const match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
    if (match === null) throwError(state, "ill-formed argument of the YAML directive");
    if (parseInt(match[1], 10) !== 1) throwError(state, "unacceptable YAML version of the document");
    state.directives.push({
      kind: "yaml",
      version: args[0]
    });
  } else if (name === "TAG") {
    if (args.length !== 2) throwError(state, "TAG directive accepts exactly two arguments");
    const [handle, prefix] = args;
    if (!PATTERN_TAG_HANDLE.test(handle)) throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
    if (HAS_OWN.call(state.tagHandlers, handle)) throwError(state, `there is a previously declared suffix for "${handle}" tag handle`);
    if (!PATTERN_TAG_PREFIX.test(prefix)) throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
    state.tagHandlers[handle] = prefix;
    state.directives.push({
      kind: "tag",
      handle,
      prefix
    });
  }
  return true;
}
function readDocument(state) {
  state.directives = [];
  state.tagHandlers = /* @__PURE__ */ Object.create(null);
  let hasDirectives = false;
  skipSeparationSpace(state, true);
  while (readDirective(state)) {
    hasDirectives = true;
    skipSeparationSpace(state, true);
  }
  let explicitStart = false;
  let explicitEnd = false;
  let allowCompact = true;
  if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 3))) {
    explicitStart = true;
    const markerLine = state.line;
    state.position += 3;
    skipSeparationSpace(state, true);
    allowCompact = state.line > markerLine;
  } else if (hasDirectives) throwError(state, "directives end mark is expected");
  const documentEventIndex = state.events.length;
  if (!explicitStart && state.position === state.lineStart && state.input.charCodeAt(state.position) === 46 && testDocumentSeparator(state)) {
    state.position += 3;
    skipSeparationSpace(state, true);
    return;
  }
  addDocumentEvent(state, explicitStart, false);
  if (!parseNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, allowCompact, allowCompact)) addEmptyScalarEvent(state);
  skipSeparationSpace(state, true);
  if (state.position === state.lineStart && testDocumentSeparator(state)) {
    explicitEnd = state.input.charCodeAt(state.position) === 46;
    if (explicitEnd) {
      const markerLine = state.line;
      state.position += 3;
      skipSeparationSpace(state, true);
      if (state.line === markerLine && state.position < state.length) throwError(state, "end of the stream or a document separator is expected");
    }
  }
  const documentEvent = state.events[documentEventIndex];
  if (documentEvent?.type === EVENT_ID.DOCUMENT) documentEvent.explicitEnd = explicitEnd;
  addPopEvent(state);
  if (!explicitEnd && state.position < state.length && !testDocumentBoundary(state)) throwError(state, "end of the stream or a document separator is expected");
}
function parseEvents(input, options) {
  const length = input.length;
  const state = {
    ...DEFAULT_PARSER_OPTIONS,
    ...options,
    input: `${input}\0`,
    length,
    position: 0,
    line: 0,
    lineStart: 0,
    lineIndent: 0,
    firstTabInLine: -1,
    depth: 0,
    directives: [],
    tagHandlers: /* @__PURE__ */ Object.create(null),
    events: []
  };
  const nullpos = input.indexOf("\0");
  if (nullpos !== -1) YAMLException.throwAt(input, nullpos, "null byte is not allowed in input", state.filename);
  while (state.position < state.length) {
    skipByteOrderMark(state);
    skipSeparationSpace(state, true);
    if (state.position >= state.length) break;
    const documentStart = state.position;
    readDocument(state);
    if (state.position === documentStart)
      throwError(state, "can not read a document");
  }
  return state.events;
}
var DEFAULT_LOAD_OPTIONS = {
  ...DEFAULT_PARSER_OPTIONS,
  ...DEFAULT_CONSTRUCTOR_OPTIONS
};
function loadDocuments(input, options = {}) {
  const opts = {
    ...DEFAULT_LOAD_OPTIONS,
    ...options
  };
  const source = String(input);
  const PARSER_OPT_KEYS = Object.keys(DEFAULT_PARSER_OPTIONS);
  const CONSTRUCTOR_OPT_KEYS = Object.keys(DEFAULT_CONSTRUCTOR_OPTIONS);
  return constructFromEvents(parseEvents(source, pick(opts, PARSER_OPT_KEYS)), {
    ...pick(opts, CONSTRUCTOR_OPT_KEYS),
    source
  });
}
function load(input, options) {
  const documents = loadDocuments(input, options);
  if (documents.length === 0) throw new YAMLException("expected a document, but the input is empty");
  if (documents.length === 1) return documents[0];
  throw new YAMLException("expected a single document in the stream, but found more");
}
function hasBit(mask, bit) {
  return (mask & 1 << bit) !== 0;
}
var DEFAULT_SCALAR_STYLE_RULES = {
  applyQuoteFlowKeysOption,
  doubleQuoteForInvisibles,
  doubleQuoteWhitespaceOnly,
  applyForceQuotesOption,
  tryLongOrMultilineAsBlock,
  quoteInvalidPlain,
  fallbackToDoubleQuoted
};
function _preferredQuotedStyle(layout) {
  if (layout.presenterOptions.quoteStyle === "single" && hasBit(layout.allowedStylesMask, SCALAR_STYLE.SINGLE_QUOTED)) return SCALAR_STYLE.SINGLE_QUOTED;
  return SCALAR_STYLE.DOUBLE_QUOTED;
}
function applyQuoteFlowKeysOption(layout) {
  if (!layout.presenterOptions.quoteFlowKeys) return;
  if (!layout.isKey || !layout.flowOnly || layout.style !== SCALAR_STYLE.PLAIN) return;
  layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
function doubleQuoteForInvisibles(layout) {
  if (layout.style === SCALAR_STYLE.PLAIN && /[\t\x7F-\xA0\u2028\u2029\uFEFF\uFFFE\uFFFF]/.test(layout.node.value)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
function doubleQuoteWhitespaceOnly(layout) {
  if (layout.style === SCALAR_STYLE.PLAIN && /^\s+$/.test(layout.node.value)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
function applyForceQuotesOption(layout) {
  if (!layout.presenterOptions.forceQuotes) return;
  if (layout.isKey || layout.style !== SCALAR_STYLE.PLAIN) return;
  layout.style = layout.node.value.includes("\n") ? SCALAR_STYLE.DOUBLE_QUOTED : _preferredQuotedStyle(layout);
}
function tryLongOrMultilineAsBlock(layout) {
  if (layout.style !== SCALAR_STYLE.PLAIN || layout.isKey) return;
  const value = layout.node.value;
  const multiline = value.indexOf("\n") !== -1;
  if (!hasBit(layout.allowedStylesMask, SCALAR_STYLE.LITERAL_BLOCK)) {
    if (multiline) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
    return;
  }
  const w = layout.presenterOptions.lineWidth;
  if (w === -1) {
    if (multiline) layout.style = SCALAR_STYLE.LITERAL_BLOCK;
    return;
  }
  const availableWidth = Math.max(Math.min(w, 40), w - layout.shiftOfContent);
  let position = 0;
  let shouldFold = false;
  while (position <= value.length) {
    let lineEnd = value.length;
    const nextLineBreak = value.indexOf("\n", position);
    if (nextLineBreak !== -1) lineEnd = nextLineBreak;
    const line = value.slice(position, lineEnd);
    if (line.length > availableWidth && line[0] !== " " && / [^ \t]/.test(line)) shouldFold = true;
    if (nextLineBreak === -1) break;
    position = nextLineBreak + 1;
  }
  if (shouldFold) layout.style = SCALAR_STYLE.FOLDED_BLOCK;
  else if (multiline) layout.style = SCALAR_STYLE.LITERAL_BLOCK;
}
function quoteInvalidPlain(layout) {
  if (layout.style === SCALAR_STYLE.PLAIN && !hasBit(layout.allowedStylesMask, SCALAR_STYLE.PLAIN)) layout.style = _preferredQuotedStyle(layout);
}
function fallbackToDoubleQuoted(layout) {
  if (!hasBit(layout.allowedStylesMask, layout.style)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
var SRC_C_PRINTABLE = "[\\x09\\x0A\\x0D\\x20-\\x7E\\x85\\xA0-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]";
var SRC_B_CHAR = "[\\n\\r]";
var SRC_C_BYTE_ORDER_MARK = "\\uFEFF";
var SRC_S_WHITE = "[ \\t]";
var SRC_NB_CHAR = `(?:(?!(?:${SRC_B_CHAR}|${SRC_C_BYTE_ORDER_MARK}))${SRC_C_PRINTABLE})`;
var SRC_NS_CHAR = `(?:(?!${SRC_S_WHITE})${SRC_NB_CHAR})`;
var SRC_NB_JSON = "[\\x09\\x20-\\uD7FF\\uE000-\\uFFFF\\u{10000}-\\u{10FFFF}]";
var SRC_C_INDICATOR = "[-?:,\\[\\]{}#&*!|>'\"%@`]";
var SRC_C_FLOW_INDICATOR = "[,\\[\\]{}]";
var SRC_NS_PLAIN_SAFE_FLOW_OUT = SRC_NS_CHAR;
var SRC_NS_PLAIN_SAFE_FLOW_IN = `(?:(?!${SRC_C_FLOW_INDICATOR})${SRC_NS_CHAR})`;
var SRC_NS_PLAIN_FIRST_FLOW_OUT = `(?:(?:(?!${SRC_C_INDICATOR})${SRC_NS_CHAR})|[?:-](?=${SRC_NS_PLAIN_SAFE_FLOW_OUT}))`;
var SRC_NS_PLAIN_FIRST_FLOW_IN = `(?:(?:(?!${SRC_C_INDICATOR})${SRC_NS_CHAR})|[?:-](?=${SRC_NS_PLAIN_SAFE_FLOW_IN}))`;
var SRC_NS_PLAIN_CHAR_FLOW_OUT = `(?:(?:(?![:#])${SRC_NS_PLAIN_SAFE_FLOW_OUT})|:(?=${SRC_NS_PLAIN_SAFE_FLOW_OUT}))#*`;
var SRC_NS_PLAIN_CHAR_FLOW_IN = `(?:(?:(?![:#])${SRC_NS_PLAIN_SAFE_FLOW_IN})|:(?=${SRC_NS_PLAIN_SAFE_FLOW_IN}))#*`;
var SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT = `(?:${SRC_S_WHITE}*${SRC_NS_PLAIN_CHAR_FLOW_OUT})*`;
var SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN = `(?:${SRC_S_WHITE}*${SRC_NS_PLAIN_CHAR_FLOW_IN})*`;
var SRC_NS_PLAIN_ONE_LINE_FLOW_OUT = `${SRC_NS_PLAIN_FIRST_FLOW_OUT}#*${SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT}`;
var SRC_NS_PLAIN_ONE_LINE_FLOW_IN = `${SRC_NS_PLAIN_FIRST_FLOW_IN}#*${SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN}`;
var SRC_NS_PLAIN_ONE_LINE_BLOCK_KEY = SRC_NS_PLAIN_ONE_LINE_FLOW_OUT;
var SRC_NS_PLAIN_ONE_LINE_FLOW_KEY = SRC_NS_PLAIN_ONE_LINE_FLOW_IN;
var SRC_S_NS_PLAIN_NEXT_LINE_FLOW_OUT = `\\n+${SRC_NS_PLAIN_CHAR_FLOW_OUT}${SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT}`;
var SRC_S_NS_PLAIN_NEXT_LINE_FLOW_IN = `\\n+${SRC_NS_PLAIN_CHAR_FLOW_IN}${SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN}`;
var SRC_NS_PLAIN_MULTI_LINE_FLOW_OUT = `${SRC_NS_PLAIN_ONE_LINE_FLOW_OUT}(?:${SRC_S_NS_PLAIN_NEXT_LINE_FLOW_OUT})*`;
var SRC_NS_PLAIN_MULTI_LINE_FLOW_IN = `${SRC_NS_PLAIN_ONE_LINE_FLOW_IN}(?:${SRC_S_NS_PLAIN_NEXT_LINE_FLOW_IN})*`;
var NS_PLAIN_FLOW_OUT = new RegExp(`^(?:${SRC_NS_PLAIN_MULTI_LINE_FLOW_OUT})$`, "u");
var NS_PLAIN_FLOW_IN = new RegExp(`^(?:${SRC_NS_PLAIN_MULTI_LINE_FLOW_IN})$`, "u");
var NS_PLAIN_BLOCK_KEY = new RegExp(`^(?:${SRC_NS_PLAIN_ONE_LINE_BLOCK_KEY})$`, "u");
var NS_PLAIN_FLOW_KEY = new RegExp(`^(?:${SRC_NS_PLAIN_ONE_LINE_FLOW_KEY})$`, "u");
var NB_SINGLE_ONE_LINE = new RegExp(`^(?:${SRC_NB_JSON})*$`, "u");
var NB_SINGLE_MULTI_LINE = new RegExp(`^(?:${SRC_NB_JSON}|\\n)*$`, "u");
var BLOCK_SCALAR_CONTENT = new RegExp(`^(?:${SRC_NB_CHAR}|\\n)*$`, "u");
var DEFAULT_PRESENTER_OPTIONS = {
  indent: 2,
  seqNoIndent: false,
  seqInlineFirst: true,
  lineWidth: 80,
  flowBracketPadding: false,
  flowSkipCommaSpace: false,
  flowSkipColonSpace: false,
  quoteFlowKeys: false,
  quoteStyle: "single",
  forceQuotes: false,
  scalarStyleRules: Object.keys(DEFAULT_SCALAR_STYLE_RULES).map((name) => Reflect.get(DEFAULT_SCALAR_STYLE_RULES, name)),
  tagBeforeAnchor: false
};
var DEFAULT_DUMP_OPTIONS = {
  ...DEFAULT_PRESENTER_OPTIONS,
  schema: DUMP_SCHEMA,
  skipInvalid: false,
  noRefs: false,
  flowLevel: -1,
  sortKeys: false,
  transform: () => {
  }
};
var EVENT_DOCUMENT = EVENT_ID.DOCUMENT;
var EVENT_SEQUENCE = EVENT_ID.SEQUENCE;
var EVENT_MAPPING = EVENT_ID.MAPPING;
var EVENT_SCALAR = EVENT_ID.SCALAR;
var EVENT_ALIAS = EVENT_ID.ALIAS;
var EVENT_POP = EVENT_ID.POP;
var SCALAR_STYLE_PLAIN = SCALAR_STYLE.PLAIN;
var SCALAR_STYLE_SINGLE_QUOTED = SCALAR_STYLE.SINGLE_QUOTED;
var SCALAR_STYLE_DOUBLE_QUOTED = SCALAR_STYLE.DOUBLE_QUOTED;
var SCALAR_STYLE_LITERAL_BLOCK = SCALAR_STYLE.LITERAL_BLOCK;
var SCALAR_STYLE_FOLDED_BLOCK = SCALAR_STYLE.FOLDED_BLOCK;
var COLLECTION_STYLE_BLOCK = COLLECTION_STYLE.BLOCK;
var COLLECTION_STYLE_FLOW = COLLECTION_STYLE.FLOW;
var CHOMPING_CLIP = CHOMPING_MODE.CLIP;
var CHOMPING_STRIP = CHOMPING_MODE.STRIP;
var CHOMPING_KEEP = CHOMPING_MODE.KEEP;

// src/domain/constants.ts
var VERSION = true ? "0.15.0" : "0.0.0-dev";
var ROUTER_DIR = ".router";

// src/io/env.ts
var BASE_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ", "TERM"];
var EXECUTOR_CONTEXT_ALLOW = [
  "USER",
  "LOGNAME",
  "SHELL",
  // macOS Keychain/session lookup used by native Claude Code.
  "SECURITYSESSIONID",
  "LaunchInstanceID",
  "XPC_FLAGS",
  "XPC_SERVICE_NAME",
  "__CF_USER_TEXT_ENCODING",
  // Explicit config/certificate locations and update policy.
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "DISABLE_AUTO_UPDATE"
];
var PROXY_URL_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
var NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"];
function copy(source, target, key) {
  const value = source[key];
  if (value !== void 0) target[key] = value;
}
function proxyHasCredentials(value) {
  if (!value.includes("://")) return value.includes("@");
  try {
    const url = new URL(value);
    return url.username !== "" || url.password !== "";
  } catch {
    return true;
  }
}
function buildWorkerEnv(source, extraKeys = []) {
  const out2 = {};
  for (const key of [...BASE_ALLOW, ...extraKeys]) copy(source, out2, key);
  return out2;
}
var EXECUTOR_SANDBOX_ENV = "ROUTER_EXECUTOR_SANDBOX";
function buildExecutorEnv(source, extraKeys = []) {
  const out2 = buildWorkerEnv(source);
  out2[EXECUTOR_SANDBOX_ENV] = "1";
  for (const key of EXECUTOR_CONTEXT_ALLOW) copy(source, out2, key);
  for (const key of NO_PROXY_KEYS) copy(source, out2, key);
  for (const key of PROXY_URL_KEYS) {
    const value = source[key];
    if (value !== void 0 && !proxyHasCredentials(value)) out2[key] = value;
  }
  for (const key of extraKeys) copy(source, out2, key);
  return out2;
}

// src/io/paths.ts
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
function branchRefPath(repoRoot, branch) {
  return join(repoRoot, ".git", "refs", "heads", ...branch.split("/"));
}
function routerPaths(routerDir) {
  const root = resolve(routerDir);
  const writeDir = (id) => join(root, "writes", id);
  return {
    root,
    repoRoot: dirname(root),
    writesDir: join(root, "writes"),
    symbolsDir: join(root, "symbols"),
    symbolLatest: join(root, "symbols", "latest"),
    planDir: (planId) => join(root, "plans", planId),
    planMd: (planId) => {
      const workplan = join(root, "plans", planId, "WORKPLAN.md");
      return existsSync(workplan) ? workplan : join(root, "plans", planId, "PLAN.md");
    },
    specCritique: (planId, round) => join(root, "plans", planId, `critique-${round}.md`),
    specDecisions: (planId) => join(root, "plans", planId, "DECISIONS.md"),
    specLock: (planId) => join(root, "plans", planId, "spec.lock"),
    symbolCache: (hash) => join(root, "symbols", `${hash}.json`),
    writeDir,
    writeRecord: (id) => join(writeDir(id), "record.json"),
    writeBrief: (id) => join(writeDir(id), "BRIEF.md"),
    writeLog: (id) => join(writeDir(id), "codex.log"),
    writeHeartbeat: (id) => join(writeDir(id), "heartbeat")
  };
}
function findRouterDir(startDir) {
  let dir = resolve(startDir);
  for (; ; ) {
    const candidate = join(dir, ROUTER_DIR);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// src/app/modelConfig.ts
import { readFileSync } from "node:fs";
import { join as join2 } from "node:path";
var DEFAULT_MODEL_CONFIG = {
  writer: { model: "gpt-5.6-sol", effort: "xhigh" },
  // design-review / review: strongest + independent (non-Claude first); fall to a same-strength
  // Claude reviewer if codex is unavailable. Review runs in the background, so its effort buys
  // judgment rather than blocking the human -- but a reviewer that thinks for fifteen minutes
  // also slows the round trip it exists to serve, and review rewards breadth over deep
  // single-chain deduction. `high` is the default; `xhigh` or `max` is an explicit opt-in.
  review: [
    { kind: "codex", model: "gpt-5.6-sol", effort: "high" },
    { kind: "claude", model: "opus", effort: "high" }
  ]
};
function modelsYamlPath(paths) {
  return join2(paths.root, "models.yaml");
}
function isSpec(v) {
  return typeof v === "object" && v !== null && typeof v.model === "string";
}
function spec(v) {
  return { model: v.model, ...v.effort ? { effort: v.effort } : {} };
}
function loadModelConfig(paths) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_MODEL_CONFIG));
  let raw;
  try {
    raw = load(readFileSync(modelsYamlPath(paths), "utf8"), { schema: JSON_SCHEMA });
  } catch {
    return cfg;
  }
  if (typeof raw !== "object" || raw === null) return cfg;
  const o = raw;
  const legacy = o.codex?.critical;
  if (isSpec(o.writer)) cfg.writer = spec(o.writer);
  else if (isSpec(legacy)) cfg.writer = spec(legacy);
  if (Array.isArray(o.review)) {
    const chain = o.review.filter(
      (r) => typeof r === "object" && r !== null && r.kind !== void 0
    );
    if (chain.length > 0) cfg.review = chain;
  }
  return cfg;
}

// src/app/write.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";

// src/core/exitTaxonomy.ts
function classifyExit(o) {
  if (o.spawnError) return "env_error";
  if (o.timedOut) return "timeout";
  if (o.stalled) return "stalled";
  if (o.killedByUs) return "killed";
  if (o.signal !== null) return "worker_crash";
  if (o.exitCode === 0) return "ok";
  return "task_failed";
}
function detectContractConflict(finalMessage) {
  if (finalMessage == null) return false;
  const first = finalMessage.split(/\r?\n/).find((line) => line.trim() !== "");
  if (first === void 0) return false;
  return /^CONTRACT_CONFLICT\b/u.test(first.trim());
}
function executorDiagnostics(logText) {
  const kept = [];
  for (const line of logText.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (!t.startsWith("{")) {
      kept.push(line);
      continue;
    }
    let type;
    try {
      type = JSON.parse(t).type;
    } catch {
      kept.push(line);
      continue;
    }
    if (typeof type === "string" && (type.startsWith("item.") || type === "assistant" || type === "user")) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}
var DEFAULT_ENV_ERROR_PATTERN = "\\b(not logged in|please run /login|authentication[_ -]?failed|failed to authenticate|invalid api key|no api key found|oauth token expired)\\b";
function reclassifyEnvironmentFailure(exitClass, logText, pattern = DEFAULT_ENV_ERROR_PATTERN) {
  if (exitClass !== "task_failed" && exitClass !== "worker_crash") return exitClass;
  return new RegExp(pattern, "i").test(executorDiagnostics(logText)) ? "env_error" : exitClass;
}
var DEFAULT_MODEL_MISMATCH_PATTERN = "\\b(unknown model|model not found|no such model|model[^\\n]{0,40}?not (found|available|supported)|invalid model|unsupported model|unrecognized model)\\b";
function detectModelMismatch(logText, pattern = DEFAULT_MODEL_MISMATCH_PATTERN) {
  return new RegExp(pattern, "i").test(executorDiagnostics(logText));
}

// src/io/atomicWrite.ts
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
var counter = 0;
function tmpPath(target) {
  counter += 1;
  return join3(dirname2(target), `.tmp.${process.pid}.${counter}.${target.length}`);
}
function writeFileAtomic(target, data) {
  mkdirSync(dirname2(target), { recursive: true });
  const tmp = tmpPath(target);
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } catch (err2) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw err2;
  }
  closeSync(fd);
  try {
    renameSync(tmp, target);
  } catch (err2) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw err2;
  }
}
function writeJsonAtomic(target, value) {
  writeFileAtomic(target, `${JSON.stringify(value, null, 2)}
`);
}

// src/io/git.ts
import { execFileSync } from "node:child_process";
var GitError = class extends Error {
  stderr;
  code;
  constructor(args, stderr, code) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    this.name = "GitError";
    this.stderr = stderr;
    this.code = code;
  }
};
function tryGit(cwd, args, input) {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      ...input !== void 0 ? { input } : {}
    });
    return { ok: true, stdout, stderr: "", code: 0 };
  } catch (err2) {
    const e = err2;
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      code: e.status ?? null
    };
  }
}
function git(cwd, args, input) {
  const r = tryGit(cwd, args, input);
  if (!r.ok) throw new GitError(args, r.stderr, r.code);
  return r.stdout;
}
function resolveCommit(cwd, ref) {
  return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
}
function currentBranch(cwd) {
  const r = tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}
function pathspec(exclude) {
  if (exclude.length === 0) return [];
  return ["--", ".", ...exclude.map((path) => `:(exclude,glob)${path}`), ...exclude.map((path) => `:(exclude,glob)${path}/**`)];
}
function uncommittedSourceFiles(cwd, exclude = []) {
  const args = ["status", "--porcelain", "--ignore-submodules=dirty", ...pathspec(exclude)];
  const r = tryGit(cwd, args);
  if (!r.ok) throw new GitError(args, r.stderr, r.code);
  return r.stdout.split("\n").filter((line) => line !== "");
}
function commitsSince(cwd, base) {
  return git(cwd, ["log", "--oneline", "--no-decorate", `${base}..HEAD`]).split("\n").filter((line) => line !== "");
}

// src/io/supervisor.ts
import { spawn } from "node:child_process";
import { closeSync as closeSync2, mkdirSync as mkdirSync2, openSync as openSync2, statSync as statSync2, writeFileSync } from "node:fs";
import { dirname as dirname3 } from "node:path";

// src/io/signals.ts
function killProcessGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err2) {
    const code = err2.code;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw err2;
  }
}
function processGroupIsGone(pgid) {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err2) {
    return err2.code === "ESRCH";
  }
}

// src/io/supervisor.ts
function waitForGroupGone(pgid, budgetMs, stepMs) {
  return new Promise((resolve5) => {
    const deadline = Date.now() + budgetMs;
    const tick = () => {
      if (processGroupIsGone(pgid)) {
        resolve5(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve5(false);
        return;
      }
      setTimeout(tick, stepMs);
    };
    tick();
  });
}
async function drainGroup(pgid, graceMs, stepMs) {
  if (processGroupIsGone(pgid)) return false;
  killProcessGroup(pgid, "SIGTERM");
  if (await waitForGroupGone(pgid, graceMs, stepMs)) return false;
  killProcessGroup(pgid, "SIGKILL");
  if (await waitForGroupGone(pgid, graceMs, stepMs)) return false;
  return true;
}
function activitySignal(logPath, watchPaths) {
  let sig = 0;
  try {
    sig += statSync2(logPath).size;
  } catch {
  }
  for (const p of watchPaths) {
    try {
      sig += Math.floor(statSync2(p).mtimeMs);
    } catch {
    }
  }
  return sig;
}
function superviseWorker(spec2) {
  const heartbeatIntervalMs = spec2.heartbeatIntervalMs ?? 2e4;
  const pollIntervalMs = spec2.pollIntervalMs ?? 1e3;
  const sigkillGraceMs = spec2.sigkillGraceMs ?? 1e4;
  const drainPollMs = Math.max(1, Math.min(50, pollIntervalMs));
  return new Promise((resolve5) => {
    mkdirSync2(dirname3(spec2.logPath), { recursive: true });
    mkdirSync2(dirname3(spec2.heartbeatPath), { recursive: true });
    const startedAtMs = Date.now();
    const logFd = openSync2(spec2.logPath, "a");
    let timedOut = false;
    let stalled = false;
    let settled = false;
    let lastActivity = startedAtMs;
    let lastSignal = activitySignal(spec2.logPath, spec2.watchPaths);
    const timers = [];
    const clearAll = () => {
      for (const t of timers) clearInterval(t);
      for (const t of timers) clearTimeout(t);
    };
    const child = spawn(spec2.argv[0], spec2.argv.slice(1), {
      cwd: spec2.cwd,
      env: spec2.env,
      detached: true,
      // worker becomes its own process-group leader
      stdio: ["ignore", logFd, logFd]
    });
    const finish = (o) => {
      if (settled) return;
      settled = true;
      clearAll();
      try {
        closeSync2(logFd);
      } catch {
      }
      const exitClass = classifyExit({
        spawnError: o.spawnError !== null,
        timedOut: o.timedOut,
        stalled: o.stalled,
        killedByUs: false,
        exitCode: o.rc,
        signal: o.signal
      });
      resolve5({ ...o, exitClass, startedAtMs, endedAtMs: Date.now() });
    };
    child.on("error", (err2) => {
      finish({
        rc: null,
        signal: null,
        timedOut: false,
        stalled: false,
        spawnError: err2.message,
        groupSurvived: false
      });
    });
    child.on("exit", (code, signal) => {
      clearAll();
      const pgid2 = child.pid;
      if (pgid2 === void 0) {
        finish({ rc: code, signal, timedOut, stalled, spawnError: null, groupSurvived: false });
        return;
      }
      void drainGroup(pgid2, sigkillGraceMs, drainPollMs).then((groupSurvived) => {
        finish({ rc: code, signal, timedOut, stalled, spawnError: null, groupSurvived });
      });
    });
    const pgid = child.pid;
    if (pgid !== void 0) {
      spec2.onPgid?.(pgid);
      let killing = false;
      const escalateKill = () => {
        if (killing) return;
        killing = true;
        killProcessGroup(pgid, "SIGTERM");
        timers.push(setTimeout(() => killProcessGroup(pgid, "SIGKILL"), sigkillGraceMs));
      };
      timers.push(
        setTimeout(() => {
          timedOut = true;
          escalateKill();
        }, spec2.maxWallMs)
      );
      timers.push(
        setInterval(() => {
          try {
            writeFileSync(spec2.heartbeatPath, `${Date.now()}
`);
          } catch {
          }
        }, heartbeatIntervalMs)
      );
      timers.push(
        setInterval(() => {
          const sig = activitySignal(spec2.logPath, spec2.watchPaths);
          if (sig !== lastSignal) {
            lastSignal = sig;
            lastActivity = Date.now();
            return;
          }
          if (Date.now() - lastActivity >= spec2.stallMs) {
            stalled = true;
            escalateKill();
          }
        }, pollIntervalMs)
      );
      try {
        writeFileSync(spec2.heartbeatPath, `${startedAtMs}
`);
      } catch {
      }
    }
  });
}

// src/app/codex.ts
function bin() {
  return process.env.ROUTER_CODEX_BIN ?? "codex";
}
function pin(argv, m) {
  argv.push("-m", m.model);
  if (m.effort !== void 0) argv.push("-c", `model_reasoning_effort=${m.effort}`);
  return argv;
}
function codexWriteArgv(prompt, cwd, m) {
  return pin([bin(), "exec", prompt, "-C", cwd, "-s", "workspace-write", "--skip-git-repo-check", "--json"], m);
}
function codexResumeArgv(sessionId, feedback, m) {
  return pin(
    [bin(), "exec", "resume", sessionId, feedback, "-c", "sandbox_mode=workspace-write", "--skip-git-repo-check", "--json"],
    m
  );
}
function parseCodexLog(logText) {
  let model = null;
  let sessionId = null;
  let finalMessage;
  for (const line of logText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const rec = o;
    if (model === null) {
      const v = rec.model ?? rec.thread?.model ?? rec.turn?.model;
      if (typeof v === "string" && v !== "") model = v;
    }
    if (sessionId === null) {
      const v = rec.session_id ?? rec.thread_id ?? rec.thread?.id ?? rec.session?.id;
      if (typeof v === "string" && v !== "") sessionId = v;
    }
    if (rec.type === "item.completed" && rec.item?.type === "agent_message" && typeof rec.item.text === "string") {
      finalMessage = rec.item.text;
    }
  }
  return { model, sessionId, ...finalMessage !== void 0 ? { finalMessage } : {} };
}

// src/app/write.ts
var WRITE_MAX_WALL_MINUTES = 120;
var WRITE_STALL_MINUTES = 20;
var WriteRefusal = class extends Error {
  constructor(message) {
    super(message);
    this.name = "WriteRefusal";
  }
};
var ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function readWriteRecord(paths, id) {
  try {
    return JSON.parse(readFileSync2(paths.writeRecord(id), "utf8"));
  } catch {
    return null;
  }
}
function requireCleanTree(repoRoot) {
  const dirty = uncommittedSourceFiles(repoRoot);
  if (dirty.length > 0) {
    throw new WriteRefusal(
      `working tree has ${dirty.length} uncommitted change(s); commit or stash them first:
  ` + dirty.slice(0, 10).join("\n  ")
    );
  }
}
function uncommittedOrUnknown(repoRoot) {
  try {
    return uncommittedSourceFiles(repoRoot);
  } catch {
    return ["<git status failed: uncommitted state unknown>"];
  }
}
async function run(paths, id, argv, branch, maxWallMinutes, stallMinutes) {
  const logPath = paths.writeLog(id);
  writeFileSync2(logPath, "");
  const outcome = await superviseWorker({
    argv,
    cwd: paths.repoRoot,
    env: buildExecutorEnv(process.env),
    logPath,
    heartbeatPath: paths.writeHeartbeat(id),
    // A commit landing is the writer actually finishing something, so the branch ref counts as
    // liveness alongside log growth.
    watchPaths: [branchRefPath(paths.repoRoot, branch)],
    maxWallMs: maxWallMinutes * 6e4,
    stallMs: stallMinutes * 6e4
  });
  return { outcome, log: readFileSync2(logPath, "utf8") };
}
function classify(outcome, log, finalMessage) {
  if (detectContractConflict(finalMessage)) return "contract_conflict";
  return reclassifyEnvironmentFailure(outcome.exitClass, log);
}
async function writeWithCodex(paths, opts) {
  if (!ID_RE.test(opts.id)) throw new WriteRefusal(`invalid write id "${opts.id}" (lowercase, digits, . _ -)`);
  if (existsSync3(paths.writeRecord(opts.id))) {
    throw new WriteRefusal(`write ${opts.id} already exists; use \`router resume ${opts.id}\` or a new id`);
  }
  const repoRoot = paths.repoRoot;
  const branch = currentBranch(repoRoot);
  if (branch === null) throw new WriteRefusal("HEAD is detached; check out a branch for the writer to commit on");
  requireCleanTree(repoRoot);
  const baseSha = resolveCommit(repoRoot, "HEAD");
  mkdirSync3(paths.writeDir(opts.id), { recursive: true });
  writeFileSync2(paths.writeBrief(opts.id), opts.brief);
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const { outcome, log } = await run(
    paths,
    opts.id,
    codexWriteArgv(writerPrompt(opts.brief), repoRoot, opts.model),
    branch,
    opts.maxWallMinutes ?? WRITE_MAX_WALL_MINUTES,
    opts.stallMinutes ?? WRITE_STALL_MINUTES
  );
  const parsed = parseCodexLog(log);
  const exitClass = classify(outcome, log, parsed.finalMessage);
  const record = {
    id: opts.id,
    model: parsed.model ?? opts.model.model,
    ...opts.model.effort !== void 0 ? { effort: opts.model.effort } : {},
    branch,
    base_sha: baseSha,
    session_id: parsed.sessionId,
    exit_class: exitClass,
    rc: outcome.rc,
    started_at: startedAt,
    ended_at: (/* @__PURE__ */ new Date()).toISOString(),
    resumes: 0,
    commits: commitsSince(repoRoot, baseSha),
    uncommitted: uncommittedOrUnknown(repoRoot),
    ...parsed.finalMessage !== void 0 ? { final_message: parsed.finalMessage } : {},
    ...exitClass !== "ok" && detectModelMismatch(log) ? { model_mismatch: true } : {}
  };
  writeJsonAtomic(paths.writeRecord(opts.id), record);
  return record;
}
async function resumeWrite(paths, id, feedback, model) {
  const prev = readWriteRecord(paths, id);
  if (prev === null) throw new WriteRefusal(`no write named ${id}; start one with \`router write\``);
  if (prev.session_id === null) {
    throw new WriteRefusal(`write ${id} recorded no codex session id; resume unavailable -- start a new write`);
  }
  const repoRoot = paths.repoRoot;
  const branch = currentBranch(repoRoot);
  if (branch !== prev.branch) {
    throw new WriteRefusal(`write ${id} ran on ${prev.branch}, but HEAD is ${branch ?? "detached"}; check it out first`);
  }
  requireCleanTree(repoRoot);
  const pin2 = model ?? { model: prev.model, ...prev.effort !== void 0 ? { effort: prev.effort } : {} };
  const { outcome, log } = await run(
    paths,
    id,
    codexResumeArgv(prev.session_id, feedback, pin2),
    branch,
    WRITE_MAX_WALL_MINUTES,
    WRITE_STALL_MINUTES
  );
  const parsed = parseCodexLog(log);
  const mismatch = parsed.sessionId !== prev.session_id;
  const exitClass = mismatch ? "task_failed" : classify(outcome, log, parsed.finalMessage);
  const record = {
    ...prev,
    exit_class: exitClass,
    rc: outcome.rc,
    ended_at: (/* @__PURE__ */ new Date()).toISOString(),
    resumes: prev.resumes + 1,
    commits: commitsSince(repoRoot, prev.base_sha),
    uncommitted: uncommittedOrUnknown(repoRoot),
    ...parsed.finalMessage !== void 0 ? { final_message: parsed.finalMessage } : {},
    ...mismatch ? { resume_session_mismatch: true } : {}
  };
  if (!mismatch) delete record.resume_session_mismatch;
  writeJsonAtomic(paths.writeRecord(id), record);
  return record;
}
function writerPrompt(brief) {
  return `${brief.trimEnd()}

---
How to deliver:
- Commit one functional unit at a time, each with a message that says why. Leave nothing uncommitted.
- Write the tests the work needs, and run them.
- Stay on the current branch. Do not merge, rebase, push, or rewrite history.
- If the code contradicts this brief in a way you cannot resolve, stop and begin your final message with CONTRACT_CONFLICT followed by the evidence.
- End with a short report: what you changed, what you ran and its result, and anything you are unsure of.
`;
}

// src/app/symbolIndex.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync4, readFileSync as readFileSync5, readdirSync as readdirSync2, rmSync, statSync as statSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { resolve as resolve3 } from "node:path";

// src/core/symbols.ts
var MEMBER_NOISE = /^(TSA_GUARDED_BY|TSA_PT_GUARDED_BY|DECLARE_|__)/;
function matchFile(idx, file) {
  return idx.files.find((e) => e.file === file || e.file.endsWith("/" + file));
}
function findSymbol(idx, needle, limit = 20) {
  const hits = [];
  for (const f of idx.files) {
    for (const s of f.symbols) {
      if (s.name.includes(needle)) {
        hits.push({ file: f.file, line: s.line, kind: s.kind, name: s.name });
      }
    }
  }
  hits.sort((a, b) => {
    const da = a.kind === "decl" ? 1 : 0;
    const db = b.kind === "decl" ? 1 : 0;
    if (da !== db) return da - db;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
  const rows = hits.slice(0, Math.max(0, limit));
  return { rows, truncated: Math.max(0, hits.length - rows.length) };
}
function enclosing(idx, file, line) {
  const f = matchFile(idx, file);
  if (f === void 0) return null;
  let best = null;
  for (const s of f.symbols) {
    if (s.line <= line && line <= s.endLine) {
      if (best === null || s.endLine - s.line < best.endLine - best.line) best = s;
    }
  }
  if (best === null) return null;
  return { file: f.file, kind: best.kind, name: best.name, line: best.line, endLine: best.endLine };
}
function methodsOf(idx, className, limit = 40) {
  let cls = null;
  let clsFile;
  for (const f of idx.files) {
    for (const s of f.symbols) {
      if ((s.kind === "class" || s.kind === "struct") && s.name === className) {
        cls = { file: f.file, kind: s.kind, name: s.name, line: s.line, endLine: s.endLine };
        clsFile = f;
      }
    }
  }
  if (cls === null || clsFile === void 0) return { cls: null, members: [], truncated: 0 };
  const all = clsFile.symbols.filter(
    (s) => (s.kind === "fn" || s.kind === "decl") && s.line > cls.line && s.endLine <= cls.endLine && !MEMBER_NOISE.test(s.name)
  );
  const members = all.slice(0, Math.max(0, limit));
  return { cls, members, truncated: Math.max(0, all.length - members.length) };
}
var simpleName = (n) => n.split("::").pop() ?? n;
function defCount(idx, name) {
  let n = 0;
  for (const f of idx.files) for (const s of f.symbols) if (simpleName(s.name) === name) n++;
  return n;
}
function callersOf(idx, name, limit = 20) {
  const rows = [];
  for (const f of idx.files) for (const e of f.calls ?? []) if (e.callee === name) rows.push({ file: f.file, line: e.line, fn: e.caller });
  const shown = rows.slice(0, Math.max(0, limit));
  return { name, rows: shown, ambiguity: defCount(idx, name), truncated: Math.max(0, rows.length - shown.length), referenceOnly: true };
}
function calleesOf(idx, fnName, limit = 40) {
  const target = simpleName(fnName);
  const rows = [];
  for (const f of idx.files) for (const e of f.calls ?? []) if (e.caller === fnName || simpleName(e.caller) === target) rows.push({ file: f.file, line: e.line, fn: e.callee });
  const shown = rows.slice(0, Math.max(0, limit));
  return { name: fnName, rows: shown, ambiguity: defCount(idx, target), truncated: Math.max(0, rows.length - shown.length), referenceOnly: true };
}
function callBanner(r) {
  const amb = r.ambiguity > 1 ? ` ${r.ambiguity} symbols share the name "${r.name}" -- results mix them.` : "";
  return `[reference only -- approximate call graph, NOT authoritative.${amb} Confirm completeness with rg and read the code before concluding.]`;
}
function renderCallers(r) {
  const head = r.rows.length === 0 ? `no caller found for ${r.name} (may be called via macro/pointer -- verify with rg)` : r.rows.map((x) => `${x.file}:${x.line}	${x.fn}`).join("\n");
  const more = r.truncated > 0 ? `
... (${r.truncated} more)` : "";
  return `${head}${more}
${callBanner(r)}`;
}
function renderCallees(r) {
  const head = r.rows.length === 0 ? `no callee found for ${r.name}` : r.rows.map((x) => `${x.file}:${x.line}	${x.fn}`).join("\n");
  const more = r.truncated > 0 ? `
... (${r.truncated} more)` : "";
  return `${head}${more}
${callBanner(r)}`;
}
function renderFind(r) {
  if (r.rows.length === 0) return "no matching symbol";
  const lines = r.rows.map((h) => `${h.file}:${h.line}	${h.kind} ${h.name}`);
  if (r.truncated > 0) lines.push(`... (${r.truncated} more; refine the name)`);
  return lines.join("\n");
}
function renderEnclosing(r) {
  if (r === null) return "no enclosing class/function";
  return `${r.file}:${r.line}-${r.endLine}	${r.kind} ${r.name}`;
}
function renderMethods(r) {
  if (r.cls === null) return "class not found";
  const lines = [`${r.cls.name} (${r.cls.file}:${r.cls.line}-${r.cls.endLine})`];
  for (const m of r.members) lines.push(`  ${m.line}	${m.name}`);
  if (r.truncated > 0) lines.push(`  ... (${r.truncated} more)`);
  return lines.join("\n");
}

// src/io/symbolCache.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync5, readdirSync, readFileSync as readFileSync4, statSync as statSync3 } from "node:fs";
import { relative, resolve as resolve2 } from "node:path";

// src/io/treeSitter.ts
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "node:fs";
import { createRequire } from "node:module";
import { dirname as dirname4, join as join5 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var WTS_BASENAMES = ["web-tree-sitter", "tree-sitter"];
function wtsRuntimeFile(dir, suffix) {
  for (const base of WTS_BASENAMES) {
    const candidate = join5(dir, `${base}${suffix}`);
    if (existsSync4(candidate)) return candidate;
  }
  return join5(dir, `tree-sitter${suffix}`);
}
function locateRuntime() {
  try {
    const req = createRequire(import.meta.url);
    const cjs = req.resolve("web-tree-sitter");
    const dir = dirname4(cjs);
    return {
      moduleHref: pathToFileURL(wtsRuntimeFile(dir, ".js")).href,
      tsWasm: wtsRuntimeFile(dir, ".wasm"),
      cppWasm: req.resolve("tree-sitter-wasms/out/tree-sitter-cpp.wasm")
    };
  } catch {
    const vendor = fileURLToPath(new URL("./vendor/", import.meta.url));
    return {
      moduleHref: pathToFileURL(join5(vendor, "tree-sitter.js")).href,
      tsWasm: join5(vendor, "tree-sitter.wasm"),
      cppWasm: join5(vendor, "tree-sitter-cpp.wasm")
    };
  }
}
var ready = null;
async function getParser() {
  if (ready === null) {
    ready = (async () => {
      const rt = locateRuntime();
      const mod = await import(rt.moduleHref);
      await mod.Parser.init({ wasmBinary: new Uint8Array(readFileSync3(rt.tsWasm)) });
      const parser = new mod.Parser();
      const cpp = await mod.Language.load(new Uint8Array(readFileSync3(rt.cppWasm)));
      parser.setLanguage(cpp);
      return { parser, grammar: `cpp@${cpp.version ?? "x"}` };
    })();
  }
  return ready;
}
var text = (n, src) => src.slice(n.startIndex, n.endIndex);
function funcName(fn, src) {
  let d = fn.childForFieldName("declarator");
  for (let hops = 0; d !== null && hops < 6; hops++) {
    if (d.type === "function_declarator") {
      const inner = d.childForFieldName("declarator");
      return inner !== null ? text(inner, src) : null;
    }
    d = d.childForFieldName("declarator") ?? d.namedChildren[0] ?? null;
  }
  return null;
}
function calleeName(callNode, src) {
  const f = callNode.childForFieldName("function");
  if (f === null) return null;
  if (f.type === "field_expression") {
    const fld = f.childForFieldName("field");
    return fld !== null ? text(fld, src) : null;
  }
  if (f.type === "qualified_identifier") {
    const name = f.childForFieldName("name");
    return name !== null ? text(name, src).split("::").pop() ?? null : null;
  }
  if (f.type === "identifier") return text(f, src);
  return null;
}
function extract(node, src, syms, calls, stack) {
  const t = node.type;
  let pushed = false;
  if (t === "class_specifier" || t === "struct_specifier") {
    const name = node.childForFieldName("name");
    if (name !== null) {
      const kind = t === "class_specifier" ? "class" : "struct";
      syms.push({ kind, name: text(name, src), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
    }
  } else if (t === "function_definition") {
    const nm = funcName(node, src);
    if (nm !== null) {
      syms.push({ kind: "fn", name: nm, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
      stack.push(nm);
      pushed = true;
    }
  } else if (t === "field_declaration" || t === "declaration") {
    const d = node.childForFieldName("declarator");
    if (d !== null && d.type === "function_declarator") {
      const inner = d.childForFieldName("declarator");
      if (inner !== null)
        syms.push({ kind: "decl", name: text(inner, src), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
    }
  } else if (t === "call_expression") {
    const callee = calleeName(node, src);
    if (callee !== null) calls.push({ caller: stack[stack.length - 1] ?? "<global>", callee, line: node.startPosition.row + 1 });
  }
  for (const c of node.namedChildren) extract(c, src, syms, calls, stack);
  if (pushed) stack.pop();
}
async function parseSymbols(src) {
  const { parser, grammar } = await getParser();
  const tree = parser.parse(src);
  const syms = [];
  const calls = [];
  try {
    extract(tree.rootNode, src, syms, calls, []);
  } finally {
    tree.delete();
  }
  return { syms, calls, grammar };
}

// src/io/symbolCache.ts
var SRC_RE = /\.(cpp|h|hpp|cc|cxx|hh)$/;
var SKIP_DIR = /* @__PURE__ */ new Set([".git", "node_modules", ".router", "dist"]);
function hashRoots(roots) {
  const norm = roots.map((r) => resolve2(r)).sort();
  return createHash("sha256").update(norm.join("\n")).digest("hex").slice(0, 16);
}
function walkFiles(root, acc) {
  let st;
  try {
    st = statSync3(root);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (SRC_RE.test(root)) acc.push(root);
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(root)) {
    if (SKIP_DIR.has(name)) continue;
    walkFiles(resolve2(root, name), acc);
  }
}
function loadRaw(cachePath) {
  try {
    return JSON.parse(readFileSync4(cachePath, "utf8"));
  } catch {
    return null;
  }
}
async function buildIndex(roots, cachePath, repoRoot, limits) {
  const files = [];
  for (const r of roots) walkFiles(resolve2(r), files);
  if (files.length > limits.maxFiles) {
    return { files: files.length, symbols: 0, reparsed: 0, degraded: { reason: `scope too large: ${files.length} files > maxFiles ${limits.maxFiles}` } };
  }
  const prev = loadRaw(cachePath);
  const prevByFile = /* @__PURE__ */ new Map();
  if (prev !== null) for (const f of prev.files) prevByFile.set(f.file, f);
  const out2 = [];
  let grammar = prev?.grammar ?? "";
  let symbols = 0;
  let reparsed = 0;
  let bytes = 0;
  for (const abs of files) {
    const rel = relative(repoRoot, abs);
    const st = statSync3(abs);
    const cached = prevByFile.get(rel);
    if (cached !== void 0 && cached.mtimeMs === st.mtimeMs) {
      out2.push(cached);
      symbols += cached.symbols.length;
      continue;
    }
    const src = readFileSync4(abs, "utf8");
    bytes += src.length;
    if (bytes > limits.maxBytes) {
      return { files: files.length, symbols: 0, reparsed, degraded: { reason: `scope too large: >${limits.maxBytes} bytes of source` } };
    }
    const parsed = await parseSymbols(src);
    grammar = parsed.grammar;
    out2.push({ file: rel, mtimeMs: st.mtimeMs, symbols: parsed.syms, calls: parsed.calls });
    symbols += parsed.syms.length;
    reparsed++;
  }
  writeJsonAtomic(cachePath, { grammar, files: out2 });
  return { files: files.length, symbols, reparsed };
}
function loadIndex(cachePath) {
  return loadRaw(cachePath);
}
async function refreshIndex(cachePath, repoRoot) {
  const idx = loadRaw(cachePath);
  if (idx === null) return null;
  const out2 = [];
  let grammar = idx.grammar;
  let reparsed = 0;
  let changed = false;
  for (const f of idx.files) {
    const abs = resolve2(repoRoot, f.file);
    let st;
    try {
      st = statSync3(abs);
    } catch {
      changed = true;
      continue;
    }
    if (st.mtimeMs === f.mtimeMs) {
      out2.push(f);
      continue;
    }
    const parsed = await parseSymbols(readFileSync4(abs, "utf8"));
    grammar = parsed.grammar;
    out2.push({ file: f.file, mtimeMs: st.mtimeMs, symbols: parsed.syms, calls: parsed.calls });
    reparsed++;
    changed = true;
  }
  const refreshed = { grammar, files: out2 };
  if (changed && existsSync5(cachePath)) writeJsonAtomic(cachePath, refreshed);
  return { index: refreshed, reparsed };
}

// src/app/symbolIndex.ts
var DEFAULT_CODE_INTEL = {
  enabled: true,
  index: { enabled: true, scope: ["."], maxFiles: 2e4, maxBytes: 5e8, refresh: "query" },
  lsp: { enabled: true }
};
function loadCodeIntelConfig(paths) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CODE_INTEL));
  let raw;
  try {
    raw = load(readFileSync5(modelsYamlPath(paths), "utf8"), { schema: JSON_SCHEMA });
  } catch {
    return cfg;
  }
  const o = raw?.codeIntelligence;
  if (typeof o !== "object" || o === null) return cfg;
  const c = o;
  if (typeof c.enabled === "boolean") cfg.enabled = c.enabled;
  const idx = c.index;
  if (idx !== void 0) {
    if (typeof idx.enabled === "boolean") cfg.index.enabled = idx.enabled;
    if (Array.isArray(idx.scope)) cfg.index.scope = idx.scope.filter((s) => typeof s === "string");
    if (typeof idx.maxFiles === "number") cfg.index.maxFiles = idx.maxFiles;
    if (typeof idx.maxBytes === "number") cfg.index.maxBytes = idx.maxBytes;
    if (idx.refresh === "query" || idx.refresh === "manual") cfg.index.refresh = idx.refresh;
  }
  const lsp = c.lsp;
  if (lsp !== void 0 && typeof lsp.enabled === "boolean") cfg.lsp.enabled = lsp.enabled;
  return cfg;
}
function isDegraded(x) {
  return typeof x === "object" && x !== null && x.degraded === true;
}
function indexEnabled(cfg) {
  if (!cfg.enabled) return { degraded: true, reason: "code intelligence disabled by config (codeIntelligence.enabled=false); using rg" };
  if (!cfg.index.enabled) return { degraded: true, reason: "symbol index disabled by config (codeIntelligence.index.enabled=false); using rg" };
  return null;
}
function rootsFor(paths, cfg, dirs) {
  const chosen = dirs.length > 0 ? dirs : cfg.index.scope;
  return chosen.map((d) => resolve3(paths.repoRoot, d));
}
async function runIndex(paths, cfg, dirs) {
  const gate = indexEnabled(cfg);
  if (gate !== null) return gate;
  const roots = rootsFor(paths, cfg, dirs);
  const hash = hashRoots(roots);
  const cache = paths.symbolCache(hash);
  const r = await buildIndex(roots, cache, paths.repoRoot, { maxFiles: cfg.index.maxFiles, maxBytes: cfg.index.maxBytes });
  if (r.degraded !== void 0) return { degraded: true, reason: `${r.degraded.reason}; narrow codeIntelligence.index.scope / raise maxFiles / disable; using rg` };
  mkdirSync4(paths.symbolsDir, { recursive: true });
  writeFileSync3(paths.symbolLatest, hash);
  return { files: r.files, symbols: r.symbols, reparsed: r.reparsed, cache };
}
async function runQuery(paths, cfg, sub, args) {
  const gate = indexEnabled(cfg);
  if (gate !== null) return gate;
  let cache;
  if (args.dirs.length > 0) {
    cache = paths.symbolCache(hashRoots(rootsFor(paths, cfg, args.dirs)));
  } else if (existsSync6(paths.symbolLatest)) {
    cache = paths.symbolCache(readFileSync5(paths.symbolLatest, "utf8").trim());
  } else {
    cache = paths.symbolCache(hashRoots(rootsFor(paths, cfg, [])));
  }
  if (!existsSync6(cache)) {
    return { degraded: true, reason: "no symbol index yet; run `router symbol index [dirs]` first; using rg" };
  }
  let index;
  let reparsed = 0;
  if (cfg.index.refresh === "query") {
    const r = await refreshIndex(cache, paths.repoRoot);
    if (r === null) return { degraded: true, reason: "symbol index unreadable; rebuild with `router symbol index`; using rg" };
    index = r.index;
    reparsed = r.reparsed;
  } else {
    index = loadIndex(cache);
    if (index === null) return { degraded: true, reason: "symbol index unreadable; rebuild with `router symbol index`; using rg" };
  }
  if (sub === "find") {
    const r = findSymbol(index, args.name ?? "", args.limit);
    return { text: renderFind(r), data: r, reparsed };
  }
  if (sub === "enclosing") {
    const r = enclosing(index, args.file ?? "", args.line ?? 0);
    return { text: renderEnclosing(r), data: r, reparsed };
  }
  if (sub === "methods") {
    const r = methodsOf(index, args.cls ?? "", args.limit);
    return { text: renderMethods(r), data: r, reparsed };
  }
  if (sub === "callers") {
    const r = callersOf(index, args.name ?? "", args.limit);
    return { text: renderCallers(r), data: r, reparsed };
  }
  if (sub === "callees") {
    const r = calleesOf(index, args.name ?? "", args.limit);
    return { text: renderCallees(r), data: r, reparsed };
  }
  return { degraded: true, reason: `unknown symbol subcommand '${sub}' (use index|find|enclosing|methods|callers|callees)` };
}

// src/app/supervise.ts
import { mkdirSync as mkdirSync5, unlinkSync as unlinkSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname as dirname5 } from "node:path";
var MAX_WALL_MS = 24 * 60 * 6e4;
var STALL_MS = 20 * 6e4;
function errorCode(error) {
  return error.code;
}
function exitCode(outcome) {
  if (outcome.rc !== null) return outcome.rc;
  if (outcome.signal !== null) {
    const signalNumber = osConstants.signals[outcome.signal];
    if (signalNumber !== void 0) return 128 + signalNumber;
  }
  if (outcome.spawnError !== null) return 127;
  return 1;
}
function signalExitCode(signal) {
  const signalNumber = osConstants.signals[signal];
  return signalNumber === void 0 ? 1 : 128 + signalNumber;
}
function bridgeTerminalSignals(diagnostics) {
  let signal = null;
  let pgid = null;
  const forward = (received) => {
    signal ??= received;
    if (pgid === null) return;
    try {
      killProcessGroup(pgid, received);
    } catch (error) {
      diagnostics.push(`could not forward ${received} to worker group ${pgid}: ${error.message}`);
    }
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    get signal() {
      return signal;
    },
    setPgid(nextPgid) {
      pgid = nextPgid;
      if (signal !== null) forward(signal);
    },
    dispose() {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  };
}
async function superviseCommand(spec2) {
  const workerHeartbeatPath = `${spec2.logPath}.heartbeat`;
  const diagnostics = [];
  const signals = bridgeTerminalSignals(diagnostics);
  try {
    if (signals.signal !== null) {
      return { exitCode: signalExitCode(signals.signal), supervision: null, diagnostics };
    }
    mkdirSync5(dirname5(spec2.logPath), { recursive: true });
    writeFileSync4(spec2.logPath, "");
    const supervision = await superviseWorker({
      argv: spec2.argv,
      cwd: spec2.cwd,
      env: spec2.env,
      logPath: spec2.logPath,
      heartbeatPath: workerHeartbeatPath,
      watchPaths: [],
      maxWallMs: MAX_WALL_MS,
      stallMs: STALL_MS,
      onPgid: (pgid) => signals.setPgid(pgid)
    });
    const code = signals.signal === null ? exitCode(supervision) : signalExitCode(signals.signal);
    return { exitCode: code, supervision, diagnostics };
  } finally {
    try {
      unlinkSync2(workerHeartbeatPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        diagnostics.push(`could not remove worker heartbeat ${workerHeartbeatPath}: ${error.message}`);
      }
    }
    signals.dispose();
  }
}

// src/cli/output.ts
function out(s) {
  process.stdout.write(`${s}
`);
}
function err(s) {
  process.stderr.write(`${s}
`);
}
function emit(json, value, human) {
  if (json) out(JSON.stringify(value));
  else out(human());
}
var CliError = class extends Error {
  code;
  constructor(message, code = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
};

// src/cli/commands.ts
function depsFor(ctx, readOnly = false) {
  if (!readOnly && (process.env[EXECUTOR_SANDBOX_ENV] ?? "") !== "") {
    throw new CliError(
      `refusing to WRITE router state from inside a writer (${EXECUTOR_SANDBOX_ENV} is set). Work through files, git and the project's own tests. Read-only verbs (plans, models, symbol) are available.`,
      2
    );
  }
  const explicit = flagStr(ctx.args.flags, "router-dir");
  const found = explicit ?? findRouterDir(ctx.cwd);
  const paths = routerPaths(found ?? join6(ctx.cwd, ROUTER_DIR));
  if (!readOnly) {
    if (!existsSync7(paths.root)) mkdirSync6(paths.root, { recursive: true });
    const gi = join6(paths.root, ".gitignore");
    if (!existsSync7(gi)) writeFileSync5(gi, "*\n");
  }
  return { paths };
}
function planLocked(path) {
  try {
    const v = JSON.parse(readFileSync6(path, "utf8"));
    return Number.isInteger(v.pid) && v.pid > 0;
  } catch {
    return false;
  }
}
function writerPin(ctx, fallback) {
  const model = flagStr(ctx.args.flags, "model");
  const effort = flagStr(ctx.args.flags, "effort");
  if (model === void 0 && effort === void 0) return fallback;
  const m = model ?? fallback.model;
  const e = effort ?? (m === fallback.model ? fallback.effort : void 0);
  return { model: m, ...e !== void 0 ? { effort: e } : {} };
}
function minutes(ctx, name) {
  const raw = flagStr(ctx.args.flags, name);
  if (raw === void 0) return void 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`--${name} must be a positive number of minutes`, 2);
  return n;
}
function writeSummary(r) {
  const lines = [
    `write ${r.id}: ${r.exit_class} (model ${r.model}${r.effort ? `/${r.effort}` : ""}, on ${r.branch})`,
    `  session:   ${r.session_id ?? "none reported"}${r.resumes > 0 ? `  (resumed ${r.resumes}x)` : ""}`,
    `  base:      ${r.base_sha.slice(0, 12)}  -- review with: git diff ${r.base_sha.slice(0, 12)}..HEAD`,
    `  commits:   ${r.commits.length === 0 ? "none" : ""}`,
    ...r.commits.map((c) => `    ${c}`)
  ];
  if (r.uncommitted.length > 0) lines.push(`  UNCOMMITTED (${r.uncommitted.length}):`, ...r.uncommitted.map((u) => `    ${u}`));
  if (r.resume_session_mismatch) {
    lines.push("  RESUME DID NOT RE-ATTACH: codex reported a different session (or none). Treat this as a fresh run.");
  }
  if (r.model_mismatch) lines.push("  the CLI rejected the model slug -- set `writer:` in .router/models.yaml");
  if (r.final_message) lines.push("  final message:", ...r.final_message.trimEnd().split("\n").map((l) => `    ${l}`));
  return lines.join("\n");
}
function writeExit(r) {
  return r.exit_class === "ok" && !r.resume_session_mismatch ? 0 : 1;
}
var write = async (ctx) => {
  const { paths } = depsFor(ctx);
  const id = flagStr(ctx.args.flags, "id") ?? ctx.args.positionals[0];
  if (id === void 0 || id === "") throw new CliError("write requires an id: router write <id> --brief <file>", 2);
  const briefPath = flagStr(ctx.args.flags, "brief");
  if (briefPath === void 0 || briefPath === "") throw new CliError("write requires --brief <file>", 2);
  let brief;
  try {
    brief = readFileSync6(resolve4(ctx.cwd, briefPath), "utf8");
  } catch (e) {
    throw new CliError(`cannot read brief ${briefPath}: ${e.message}`, 2);
  }
  if (brief.trim() === "") throw new CliError(`brief ${briefPath} is empty`, 2);
  const maxWall = minutes(ctx, "max-wall-minutes");
  const stall = minutes(ctx, "stall-minutes");
  try {
    const r = await writeWithCodex(paths, {
      id,
      brief,
      model: writerPin(ctx, loadModelConfig(paths).writer),
      ...maxWall !== void 0 ? { maxWallMinutes: maxWall } : {},
      ...stall !== void 0 ? { stallMinutes: stall } : {}
    });
    emit(ctx.json, { ok: writeExit(r) === 0, ...r }, () => writeSummary(r));
    return writeExit(r);
  } catch (e) {
    if (e instanceof WriteRefusal) throw new CliError(e.message, 2);
    throw e;
  }
};
var resume = async (ctx) => {
  const { paths } = depsFor(ctx);
  const id = flagStr(ctx.args.flags, "id") ?? ctx.args.positionals[0];
  if (id === void 0 || id === "") throw new CliError('resume requires an id: router resume <id> --feedback "..."', 2);
  const feedback = flagStr(ctx.args.flags, "feedback");
  if (feedback === void 0 || feedback.trim() === "") throw new CliError('resume requires --feedback "<what to fix>"', 2);
  const prev = readWriteRecord(paths, id);
  const fallback = prev === null ? void 0 : { model: prev.model, ...prev.effort !== void 0 ? { effort: prev.effort } : {} };
  try {
    const r = await resumeWrite(paths, id, feedback, fallback === void 0 ? void 0 : writerPin(ctx, fallback));
    emit(ctx.json, { ok: writeExit(r) === 0, ...r }, () => writeSummary(r));
    return writeExit(r);
  } catch (e) {
    if (e instanceof WriteRefusal) throw new CliError(e.message, 2);
    throw e;
  }
};
var pad = (s, n) => s.length >= n ? s : s + " ".repeat(n - s.length);
var DOCUMENT_FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
var BRAINSTORM_STATUSES = /* @__PURE__ */ new Set(["brainstorming", "converged", "rejected"]);
var DESIGN_STATUSES = /* @__PURE__ */ new Set([
  "design_draft",
  "design_approved",
  "design_implemented",
  "design_abandoned"
]);
var LEGACY_PLAN_STATUSES = /* @__PURE__ */ new Set(["plan_draft", "plan_approved", "executing", "done"]);
function documentFrontmatter(text2) {
  const match = DOCUMENT_FRONTMATTER_RE.exec(text2);
  if (match === null) return null;
  let parsed;
  try {
    parsed = load(match[1], { schema: JSON_SCHEMA });
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed;
}
function scalarText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}
function planRevision(frontmatter) {
  return scalarText(frontmatter?.revision) ?? scalarText(frontmatter?.plan_revision);
}
function planDocument(paths, planId, name) {
  try {
    const text2 = readFileSync6(join6(paths.planDir(planId), name), "utf8");
    return { exists: true, frontmatter: documentFrontmatter(text2) };
  } catch (error) {
    return { exists: error.code !== "ENOENT", frontmatter: null };
  }
}
function documentStage(frontmatter, allowed) {
  const status = frontmatter?.status;
  return typeof status === "string" && allowed.has(status) ? status : null;
}
function printable(raw) {
  return raw.replace(/[^\x20-\x7e]/g, ".");
}
var CELL_MAX = 32;
function frontmatterCell(raw) {
  const clean = printable(raw);
  return clean.length <= CELL_MAX ? clean : `${clean.slice(0, CELL_MAX - 3)}...`;
}
var UNREADABLE_DOCUMENT = "!unreadable";
function unrecognizedStage(frontmatter, allowed) {
  const status = frontmatter?.status;
  if (status === void 0 || status === null || typeof status === "object") return null;
  if (documentStage(frontmatter, allowed) !== null) return null;
  const shown = String(status).replace(/^ +| +$/g, "");
  return shown === "" ? null : `?${printable(shown)}`;
}
function highestCritiqueRound(entries) {
  let max = null;
  for (const name of entries) {
    const m = /^critique-(\d+)\.md$/.exec(name);
    if (m === null) continue;
    const n = Number(m[1]);
    if (max === null || n > max) max = n;
  }
  return max;
}
var plans = (ctx) => {
  const explicit = flagStr(ctx.args.flags, "router-dir");
  const paths = routerPaths(explicit ?? findRouterDir(ctx.cwd) ?? join6(ctx.cwd, ROUTER_DIR));
  const plansRoot = join6(paths.root, "plans");
  const ids = existsSync7(plansRoot) ? readdirSync3(plansRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  const rows = ids.map((id) => {
    let planFrontmatter = null;
    let hasPlan = true;
    try {
      planFrontmatter = documentFrontmatter(readFileSync6(paths.planMd(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") hasPlan = false;
    }
    let stage = hasPlan ? documentStage(planFrontmatter, LEGACY_PLAN_STATUSES) : null;
    let designRevision = null;
    let designFrontmatter = null;
    let hasDesign = true;
    try {
      designFrontmatter = documentFrontmatter(readFileSync6(join6(paths.planDir(id), "DESIGN.md"), "utf8"));
      designRevision = scalarText(designFrontmatter?.revision);
    } catch (error) {
      if (error.code === "ENOENT") hasDesign = false;
    }
    const declared = (frontmatter, allowed) => frontmatter === null ? UNREADABLE_DOCUMENT : documentStage(frontmatter, allowed) ?? unrecognizedStage(frontmatter, allowed);
    if (hasPlan) {
      stage ??= declared(planFrontmatter, LEGACY_PLAN_STATUSES);
    } else if (hasDesign) {
      stage = declared(designFrontmatter, DESIGN_STATUSES);
    } else {
      const brainstorm = planDocument(paths, id, "BRAINSTORM.md");
      stage = brainstorm.exists ? declared(brainstorm.frontmatter, BRAINSTORM_STATUSES) : null;
    }
    let critiqueRound = null;
    try {
      critiqueRound = highestCritiqueRound(readdirSync3(paths.planDir(id)));
    } catch {
    }
    return {
      id,
      plan_revision: planRevision(planFrontmatter),
      design_revision: designRevision,
      stage,
      critique_round: critiqueRound,
      decisions: existsSync7(paths.specDecisions(id)),
      locked: planLocked(paths.specLock(id))
    };
  });
  emit(ctx.json, { ok: true, plans: rows }, () => {
    if (rows.length === 0) return "No plans in .router/plans.";
    const cell = frontmatterCell;
    const width = (header, floor, values) => Math.max(floor, header.length + 1, ...values.map((value) => value.length + 1));
    const idWidth = width("id", 24, rows.map((r) => printable(r.id)));
    const revisionWidth = width("workplan", 12, rows.map((r) => cell(r.plan_revision ?? "-")));
    const designWidth = width("design", 8, rows.map((r) => cell(r.design_revision ?? "-")));
    const stageWidth = width("stage", 8, rows.map((r) => cell(r.stage ?? "-")));
    const critiqueWidth = width("critique", 10, rows.map((r) => r.critique_round === null ? "-" : String(r.critique_round)));
    const decisionsWidth = width("decisions", 12, rows.map((r) => r.decisions ? "yes" : "-"));
    const lines = [
      `Plans (${rows.length}):`,
      pad("id", idWidth) + pad("design", designWidth) + pad("workplan", revisionWidth) + pad("stage", stageWidth) + pad("critique", critiqueWidth) + pad("decisions", decisionsWidth) + "locked"
    ];
    for (const r of rows)
      lines.push(
        pad(printable(r.id), idWidth) + pad(cell(r.design_revision ?? "-"), designWidth) + pad(cell(r.plan_revision ?? "-"), revisionWidth) + pad(cell(r.stage ?? "-"), stageWidth) + pad(r.critique_round === null ? "-" : String(r.critique_round), critiqueWidth) + pad(r.decisions ? "yes" : "-", decisionsWidth) + (r.locked ? "yes" : "-")
      );
    return lines.join("\n");
  });
  return 0;
};
var models = (ctx) => {
  const { paths } = depsFor(
    ctx,
    true
    /* read-only */
  );
  const cfg = loadModelConfig(paths);
  emit(ctx.json, { ok: true, models: cfg }, () => {
    const writer = `${cfg.writer.model}${cfg.writer.effort ? `/${cfg.writer.effort}` : ""}`;
    const review = cfg.review.map((r) => `${r.kind}:${r.model ?? "?"}${r.effort ? `/${r.effort}` : ""}`).join(" -> ");
    const src = existsSync7(modelsYamlPath(paths)) ? "default + .router/models.yaml" : "default";
    return `models (${src}):
  writer: codex:${writer}
  review: ${review}`;
  });
  return 0;
};
var symbol = async (ctx) => {
  const { paths } = depsFor(ctx);
  const cfg = loadCodeIntelConfig(paths);
  const sub = ctx.args.positionals[0] ?? "";
  const limitStr = flagStr(ctx.args.flags, "limit");
  const limit = limitStr !== void 0 ? Number(limitStr) : void 0;
  if (sub === "index") {
    const dirs = ctx.args.positionals.slice(1);
    const r2 = await runIndex(paths, cfg, dirs);
    if (isDegraded(r2)) {
      emit(ctx.json, { ok: false, degraded: true, reason: r2.reason }, () => `code-intel: ${r2.reason}`);
      return 0;
    }
    emit(
      ctx.json,
      { ok: true, files: r2.files, symbols: r2.symbols, reparsed: r2.reparsed, cache: r2.cache },
      () => `indexed ${r2.files} files, ${r2.symbols} symbols (${r2.reparsed} parsed) -> ${r2.cache}`
    );
    return 0;
  }
  if (sub !== "find" && sub !== "enclosing" && sub !== "methods" && sub !== "callers" && sub !== "callees") {
    throw new CliError(`usage: router symbol index|find|enclosing|methods|callers|callees`, 2);
  }
  const p1 = ctx.args.positionals[1];
  const p2 = ctx.args.positionals[2];
  const r = await runQuery(paths, cfg, sub, {
    name: p1,
    file: p1,
    line: p2 !== void 0 ? Number(p2) : void 0,
    cls: p1,
    limit,
    dirs: []
  });
  if (isDegraded(r)) {
    emit(ctx.json, { ok: false, degraded: true, reason: r.reason }, () => `code-intel: ${r.reason}`);
    return 0;
  }
  const note = r.reparsed > 0 ? `
  (refreshed ${r.reparsed} file${r.reparsed === 1 ? "" : "s"})` : "";
  emit(ctx.json, { ok: true, result: r.data, reparsed: r.reparsed }, () => `${r.text}${note}`);
  return 0;
};
function describeLoadFailure(e) {
  const err2 = e;
  const parts = [
    err2?.name ?? typeof e,
    ...typeof err2?.code === "string" ? [err2.code] : [],
    ...typeof err2?.message === "string" && err2.message.trim() !== "" ? [err2.message] : []
  ];
  const detail = parts.join(": ");
  return typeof err2?.message === "string" && err2.message.trim() === "" ? `${detail} -- no message; usually a grammar the runtime will not accept, so check web-tree-sitter and tree-sitter-wasms against each other` : detail;
}
var doctor = async (ctx) => {
  const { paths } = depsFor(
    ctx,
    true
    /* read-only */
  );
  const cfg = loadCodeIntelConfig(paths);
  let wasmOk = false;
  let wasmDetail = "";
  try {
    const parsed = await parseSymbols("class Probe { void m(); };");
    wasmOk = parsed.syms.length > 0;
    wasmDetail = `grammar ${parsed.grammar}`;
  } catch (e) {
    wasmDetail = describeLoadFailure(e);
  }
  const cacheWritable = existsSync7(paths.root);
  emit(
    ctx.json,
    {
      ok: wasmOk,
      node: process.version,
      code_intelligence: { enabled: cfg.enabled, index: cfg.index.enabled, lsp: cfg.lsp.enabled },
      scope: cfg.index.scope,
      wasm_ok: wasmOk,
      wasm_detail: wasmDetail,
      symbols_dir: paths.symbolsDir,
      cache_writable: cacheWritable
    },
    () => `router doctor
  node:          ${process.version}
  code intel:    master=${cfg.enabled} index=${cfg.index.enabled} lsp=${cfg.lsp.enabled}
  index scope:   ${cfg.index.scope.join(", ")}  (maxFiles ${cfg.index.maxFiles})
  tree-sitter:   ${wasmOk ? "OK" : "UNAVAILABLE"} (${wasmDetail})
  symbols dir:   ${paths.symbolsDir} ${cacheWritable ? "(writable)" : "(missing)"}
` + (wasmOk ? "" : "  -> symbol index unavailable; spec/review/go will use rg.\n")
  );
  return wasmOk ? 0 : 1;
};
var superviseHandler = async (ctx) => {
  const log = flagStr(ctx.args.flags, "log");
  if (log === void 0 || log === "") throw new CliError("supervise requires --log <file>", 2);
  const argv = ctx.args.passthrough;
  if (argv === void 0) throw new CliError("supervise requires '--' before the command", 2);
  if (argv.length === 0 || argv[0] === "") throw new CliError("supervise requires a command after --", 2);
  void flagStr(ctx.args.flags, "label");
  const result = await superviseCommand({
    logPath: resolve4(ctx.cwd, log),
    argv,
    cwd: ctx.cwd,
    // Match direct foreground execution: the caller chooses the command and its environment.
    env: process.env
  });
  for (const diagnostic of result.diagnostics) err(`router: supervise cleanup: ${diagnostic}`);
  return result.exitCode;
};
var HANDLERS = {
  write,
  resume,
  plans,
  models,
  symbol,
  doctor,
  supervise: superviseHandler
};
function versionText() {
  return VERSION;
}
function helpText() {
  return `router ${VERSION}

Usage: router <command> [options]

  write <id> --brief <file> [--model M] [--effort E]  have codex write on the current branch (clean tree required)
  resume <id> --feedback "..."  send feedback to that write's same codex session
  plans                  list .router/plans/<id> artifacts: revision, stage, critique round, decisions, lock
  models                 print the writer and reviewer models (default + .router/models.yaml)
  symbol <sub> [args]    out-of-context symbol index: index [dirs] | find <name> | enclosing <file> <line> | methods <Class> | callers <name> | callees <fn>
  doctor                 self-check the code-intelligence layer (config, wasm, cache)
  supervise --log F -- <argv...>  run a long command under the watchdog, output to F

Flags: --json, --limit, --id, --brief, --model, --effort, --feedback, --max-wall-minutes, --stall-minutes, --log, --router-dir
`;
}

// src/cli/main.ts
async function runCli(argv, cwd = process.cwd()) {
  const first = argv[0];
  if (first === "--version" || first === "-V") {
    out(versionText());
    return 0;
  }
  if (first === void 0 || first === "--help" || first === "-h" || first === "help") {
    out(helpText());
    return first === void 0 ? 1 : 0;
  }
  const parsed = parseArgs(argv);
  const handler = HANDLERS[parsed.verb ?? ""];
  if (handler === void 0) {
    err(`router: unknown command '${parsed.verb}'`);
    return 2;
  }
  const json = flagBool(parsed.flags, "json");
  try {
    return await handler({ args: parsed, cwd, json });
  } catch (e) {
    if (e instanceof CliError) {
      if (json) out(JSON.stringify({ ok: false, error: e.message }));
      else err(`router: ${e.message}`);
      return e.code;
    }
    err(`router: ${e.message}`);
    return 1;
  }
}

// src/index.ts
process.exitCode = await runCli(process.argv.slice(2));
