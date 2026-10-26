/**
 * protoc for the C++ runtime: from a course's .proto files (proto3), the headers protoc and its
 * gRPC plugin would write — `<name>.pb.h` (message classes with protoc's accessors, enums) and
 * `<name>.grpc.pb.h` (each service's Stub, StubInterface, NewStub and Service) — over the
 * runtime's protobuf and grpc++ models (cppruntime/include/google/protobuf, cppruntime/include/
 * grpcpp). Generated code is compiled with every program, so it is kept small: accessors are
 * one-liners on plain members; serialization, JSON and DebugString are generic in the runtime's
 * library, driven by a field table each class carries.
 *
 * compile() in ../cpp.ts runs this over the .proto files of a job's support and puts the headers
 * under /work/gen, on the include path.
 */

// ---- parsing ---------------------------------------------------------------------------------

type Scalar =
  | 'double'
  | 'float'
  | 'int64'
  | 'uint64'
  | 'int32'
  | 'fixed64'
  | 'fixed32'
  | 'bool'
  | 'string'
  | 'bytes'
  | 'uint32'
  | 'sfixed32'
  | 'sfixed64'
  | 'sint32'
  | 'sint64';

const SCALARS: Record<Scalar, {cpp: string; kind: string}> = {
  double: {cpp: 'double', kind: 'kDouble'},
  float: {cpp: 'float', kind: 'kFloat'},
  int64: {cpp: '::int64_t', kind: 'kInt64'},
  uint64: {cpp: '::uint64_t', kind: 'kUInt64'},
  int32: {cpp: '::int32_t', kind: 'kInt32'},
  fixed64: {cpp: '::uint64_t', kind: 'kFixed64'},
  fixed32: {cpp: '::uint32_t', kind: 'kFixed32'},
  bool: {cpp: 'bool', kind: 'kBool'},
  string: {cpp: '::std::string', kind: 'kString'},
  bytes: {cpp: '::std::string', kind: 'kBytes'},
  uint32: {cpp: '::uint32_t', kind: 'kUInt32'},
  sfixed32: {cpp: '::int32_t', kind: 'kSFixed32'},
  sfixed64: {cpp: '::int64_t', kind: 'kSFixed64'},
  sint32: {cpp: '::int32_t', kind: 'kSInt32'},
  sint64: {cpp: '::int64_t', kind: 'kSInt64'},
};

const isScalar = (t: string): t is Scalar => Object.hasOwn(SCALARS, t);

interface EnumDef {
  kind: 'enum';
  name: string;
  /** Full proto name: pkg.Outer.Name. */
  full: string;
  /** C++ name at namespace scope: Outer_Name. */
  cpp: string;
  values: {name: string; number: number}[];
  parent: MessageDef | null;
  file: ProtoFile;
}

interface FieldDef {
  name: string;
  number: number;
  label: 'singular' | 'repeated' | 'map';
  /** Scalar name, or a type reference resolved into `ref`. */
  type: string;
  keyType?: Scalar;
  ref?: MessageDef | EnumDef;
  /** Index into the message's oneofs. */
  oneof: number;
  jsonName: string;
}

interface OneofDef {
  name: string;
  /** proto3 `optional`: a oneof of one, with has_ but no case accessors. */
  synthetic: boolean;
}

interface MessageDef {
  kind: 'message';
  name: string;
  full: string;
  cpp: string;
  fields: FieldDef[];
  oneofs: OneofDef[];
  messages: MessageDef[];
  enums: EnumDef[];
  parent: MessageDef | null;
  file: ProtoFile;
}

interface MethodDef {
  name: string;
  input: string;
  output: string;
  inputRef?: MessageDef;
  outputRef?: MessageDef;
  clientStreaming: boolean;
  serverStreaming: boolean;
}

interface ServiceDef {
  name: string;
  full: string;
  methods: MethodDef[];
}

interface ProtoFile {
  path: string;
  pkg: string;
  imports: string[];
  messages: MessageDef[];
  enums: EnumDef[];
  services: ServiceDef[];
}

export class ProtoError extends Error {}

const tokenize = (text: string, path: string): string[] => {
  const tokens: string[] = [];
  const re =
    /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][\w.]*|\.[A-Za-z_][\w.]*|-?\d[\w.+-]*|[{}()[\]<>;=,:]/y;
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (m === null) throw new ProtoError(`${path}: unexpected ${JSON.stringify(text.slice(at, at + 20))}`);
    at = re.lastIndex;
    const t = m[0];
    if (/^\s/.test(t) || t.startsWith('//') || t.startsWith('/*')) continue;
    tokens.push(t);
  }
  return tokens;
};

/** protoc's json_name: lowerCamelCase, underscores dropped. */
const jsonName = (name: string): string =>
  name.replace(/_+([a-zA-Z0-9])?/g, (_, c: string | undefined) => (c ?? '').toUpperCase());

const parseFile = (path: string, text: string): ProtoFile => {
  const tokens = tokenize(text, path);
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const next = (): string => {
    const t = tokens[i++];
    if (t === undefined) throw new ProtoError(`${path}: unexpected end of file`);
    return t;
  };
  const expect = (t: string): void => {
    const got = next();
    if (got !== t) throw new ProtoError(`${path}: expected ${t}, got ${got}`);
  };
  const unquote = (t: string): string =>
    JSON.parse(
      `"${t
        .slice(1, -1)
        .replace(/\\'/g, "'")
        .replace(/(?<!\\)"/g, '\\"')}"`,
    ) as string;
  /** Skip a statement or block up to its end (options, reserved, extensions). */
  const skipStatement = (): void => {
    let depth = 0;
    for (;;) {
      const t = next();
      if (t === '{') depth += 1;
      else if (t === '}') {
        depth -= 1;
        if (depth === 0) return;
      } else if (t === ';' && depth === 0) return;
    }
  };
  /** `[json_name = "x", deprecated = true]`: the options that matter here. */
  const fieldOptions = (): Record<string, string> => {
    const out: Record<string, string> = {};
    if (peek() !== '[') return out;
    next();
    while (peek() !== ']') {
      let key = next();
      if (key === '(') {
        key = `(${next()})`;
        expect(')');
      }
      expect('=');
      let value = next();
      if (value === '{') {
        let depth = 1;
        while (depth > 0) {
          const t = next();
          if (t === '{') depth += 1;
          if (t === '}') depth -= 1;
        }
        value = '';
      }
      out[key] = value.startsWith('"') ? unquote(value) : value;
      if (peek() === ',') next();
    }
    expect(']');
    return out;
  };

  const file: ProtoFile = {path, pkg: '', imports: [], messages: [], enums: [], services: []};
  const scopeName = (parent: MessageDef | null, name: string): string =>
    parent !== null ? `${parent.full}.${name}` : file.pkg ? `${file.pkg}.${name}` : name;
  const cppName = (parent: MessageDef | null, name: string): string =>
    parent !== null ? `${parent.cpp}_${name}` : name;

  const parseEnum = (parent: MessageDef | null): EnumDef => {
    const name = next();
    const e: EnumDef = {
      kind: 'enum',
      name,
      full: scopeName(parent, name),
      cpp: cppName(parent, name),
      values: [],
      parent,
      file,
    };
    expect('{');
    while (peek() !== '}') {
      const t = next();
      if (t === ';') continue;
      if (t === 'option' || t === 'reserved') {
        skipStatement();
        continue;
      }
      expect('=');
      const number = Number(next());
      fieldOptions();
      expect(';');
      e.values.push({name: t, number});
    }
    expect('}');
    return e;
  };

  const parseMessage = (parent: MessageDef | null): MessageDef => {
    const name = next();
    const m: MessageDef = {
      kind: 'message',
      name,
      full: scopeName(parent, name),
      cpp: cppName(parent, name),
      fields: [],
      oneofs: [],
      messages: [],
      enums: [],
      parent,
      file,
    };
    const field = (label: FieldDef['label'], type: string, oneof: number, keyType?: Scalar): void => {
      const fname = next();
      expect('=');
      const number = Number(next());
      const options = fieldOptions();
      expect(';');
      m.fields.push({name: fname, number, label, type, keyType, oneof, jsonName: options.json_name ?? jsonName(fname)});
    };
    expect('{');
    while (peek() !== '}') {
      const t = next();
      if (t === ';') continue;
      if (t === 'message') m.messages.push(parseMessage(m));
      else if (t === 'enum') m.enums.push(parseEnum(m));
      else if (t === 'option' || t === 'reserved' || t === 'extensions' || t === 'extend') skipStatement();
      else if (t === 'oneof') {
        const index = m.oneofs.length;
        m.oneofs.push({name: next(), synthetic: false});
        expect('{');
        while (peek() !== '}') {
          const u = next();
          if (u === ';') continue;
          if (u === 'option') {
            skipStatement();
            continue;
          }
          field('singular', u, index);
        }
        expect('}');
      } else if (t === 'map') {
        expect('<');
        const key = next();
        if (!isScalar(key) || key === 'double' || key === 'float' || key === 'bytes')
          throw new ProtoError(`${path}: invalid map key type ${key}`);
        expect(',');
        const value = next();
        expect('>');
        field('map', value, -1, key);
      } else if (t === 'repeated') {
        field('repeated', next(), -1);
      } else if (t === 'optional') {
        const type = next();
        const index = m.oneofs.length;
        m.oneofs.push({name: '', synthetic: true});
        field('singular', type, index);
        m.oneofs[index].name = `_${m.fields[m.fields.length - 1].name}`;
      } else if (t === 'required') {
        throw new ProtoError(`${path}: proto2 'required' fields are not supported`);
      } else if (t === 'group') {
        throw new ProtoError(`${path}: groups are not supported`);
      } else {
        field('singular', t, -1);
      }
    }
    expect('}');
    return m;
  };

  const parseService = (): ServiceDef => {
    const name = next();
    const s: ServiceDef = {name, full: file.pkg ? `${file.pkg}.${name}` : name, methods: []};
    expect('{');
    while (peek() !== '}') {
      const t = next();
      if (t === ';') continue;
      if (t === 'option') {
        skipStatement();
        continue;
      }
      if (t !== 'rpc') throw new ProtoError(`${path}: unexpected ${t} in service ${name}`);
      const mname = next();
      expect('(');
      let clientStreaming = false;
      if (peek() === 'stream') {
        next();
        clientStreaming = true;
      }
      const input = next();
      expect(')');
      expect('returns');
      expect('(');
      let serverStreaming = false;
      if (peek() === 'stream') {
        next();
        serverStreaming = true;
      }
      const output = next();
      expect(')');
      if (peek() === '{') skipStatement();
      else expect(';');
      s.methods.push({name: mname, input, output, clientStreaming, serverStreaming});
    }
    expect('}');
    return s;
  };

  while (i < tokens.length) {
    const t = next();
    if (t === ';') continue;
    if (t === 'syntax' || t === 'edition') {
      expect('=');
      const v = unquote(next());
      if (v !== 'proto3') throw new ProtoError(`${path}: only proto3 is supported (syntax = "${v}")`);
      expect(';');
    } else if (t === 'package') {
      file.pkg = next();
      expect(';');
    } else if (t === 'import') {
      let target = next();
      if (target === 'public' || target === 'weak') target = next();
      file.imports.push(unquote(target));
      expect(';');
    } else if (t === 'option') {
      skipStatement();
    } else if (t === 'message') {
      file.messages.push(parseMessage(null));
    } else if (t === 'enum') {
      file.enums.push(parseEnum(null));
    } else if (t === 'service') {
      file.services.push(parseService());
    } else {
      throw new ProtoError(`${path}: unexpected ${t}`);
    }
  }
  return file;
};

// ---- resolving --------------------------------------------------------------------------------

const allMessages = (ms: MessageDef[]): MessageDef[] => ms.flatMap(m => [m, ...allMessages(m.messages)]);
const allEnums = (f: ProtoFile): EnumDef[] => [...f.enums, ...allMessages(f.messages).flatMap(m => m.enums)];

/** Resolve type references as protoc does: from the innermost scope outwards. */
const resolveAll = (files: ProtoFile[]): void => {
  const symbols = new Map<string, MessageDef | EnumDef>();
  for (const f of files) {
    for (const m of allMessages(f.messages)) symbols.set(m.full, m);
    for (const e of allEnums(f)) symbols.set(e.full, e);
  }
  const lookup = (ref: string, scope: string, where: string): MessageDef | EnumDef => {
    if (ref.startsWith('.')) {
      const hit = symbols.get(ref.slice(1));
      if (hit !== undefined) return hit;
    } else {
      const parts = scope ? scope.split('.') : [];
      for (let n = parts.length; n >= 0; n -= 1) {
        const hit = symbols.get([...parts.slice(0, n), ref].join('.'));
        if (hit !== undefined) return hit;
      }
    }
    throw new ProtoError(`${where}: unknown type ${ref}`);
  };
  for (const f of files) {
    for (const m of allMessages(f.messages)) {
      for (const field of m.fields) {
        if (!isScalar(field.type)) field.ref = lookup(field.type, m.full, `${f.path}: ${m.full}.${field.name}`);
      }
    }
    for (const s of f.services) {
      for (const method of s.methods) {
        const where = `${f.path}: ${s.full}.${method.name}`;
        const input = lookup(method.input, f.pkg, where);
        const output = lookup(method.output, f.pkg, where);
        if (input.kind !== 'message' || output.kind !== 'message')
          throw new ProtoError(`${where}: requests and responses are messages`);
        method.inputRef = input;
        method.outputRef = output;
      }
    }
  }
};

// ---- generating -------------------------------------------------------------------------------

const CPP_KEYWORDS = new Set(
  (
    'alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class ' +
    'compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype ' +
    'default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int ' +
    'long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register ' +
    'reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template ' +
    'this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t ' +
    'while xor xor_eq NULL'
  ).split(' '),
);

const PB = '::google::protobuf';
const PBI = '::google::protobuf::internal';

/** The C++ namespace of a package: notes.v1 → notes::v1. */
const namespaceOf = (pkg: string): string => pkg.split('.').filter(Boolean).join('::');
const qualified = (d: MessageDef | EnumDef): string => {
  const ns = namespaceOf(d.file.pkg);
  return ns ? `::${ns}::${d.cpp}` : `::${d.cpp}`;
};

/** The accessor name protoc gives a field: lower case, a C++ keyword gets an underscore. */
const accessor = (name: string): string => {
  const lower = name.toLowerCase();
  return CPP_KEYWORDS.has(lower) ? `${lower}_` : lower;
};
const camel = (name: string): string =>
  name
    .split('_')
    .filter(Boolean)
    .map(p => p[0].toUpperCase() + p.slice(1))
    .join('');

/** The value type C++ code sees for a field of this type (an enum is its enum type). */
const valueType = (f: FieldDef): string => (f.ref === undefined ? SCALARS[f.type as Scalar].cpp : qualified(f.ref));
const kindOf = (f: FieldDef): string =>
  f.ref === undefined ? SCALARS[f.type as Scalar].kind : f.ref.kind === 'enum' ? 'kEnum' : 'kMessage';
const isStringField = (f: FieldDef): boolean => f.type === 'string' || f.type === 'bytes';

const headerName = (path: string, suffix: string): string => path.replace(/\.proto$/, suffix);

const genEnum = (e: EnumDef): string => {
  const prefix = e.parent !== null ? `${e.cpp}_` : '';
  const values = e.values.map(v => `  ${prefix}${v.name} = ${v.number},`).join('\n');
  const sorted = [...e.values].sort((a, b) => a.number - b.number);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return `enum ${e.cpp} : int {
${values}
};
inline const ${PBI}::EnumInfo& ${e.cpp}_lb_enum() {
  static const ${PBI}::EnumValue values[] = {${e.values.map(v => `{${v.number}, "${v.name}"}`).join(', ')}};
  static const ${PBI}::EnumInfo info{"${e.full}", values, ${e.values.length}};
  return info;
}
constexpr ${e.cpp} ${e.cpp}_MIN = ${prefix}${min.name};
constexpr ${e.cpp} ${e.cpp}_MAX = ${prefix}${max.name};
constexpr int ${e.cpp}_ARRAYSIZE = ${max.number} + 1;
inline bool ${e.cpp}_IsValid(int value) { return ${PBI}::enum_valid(${e.cpp}_lb_enum(), value); }
template <class T>
const ::std::string& ${e.cpp}_Name(T value) { return ${PBI}::enum_name(${e.cpp}_lb_enum(), static_cast<int>(value)); }
inline bool ${e.cpp}_Parse(::std::string_view name, ${e.cpp}* value) {
  int n = 0;
  if (!${PBI}::enum_parse(${e.cpp}_lb_enum(), name, &n)) return false;
  *value = static_cast<${e.cpp}>(n);
  return true;
}
`;
};

/** A nested enum's names inside its message, as protoc gives them. */
const nestedEnumAliases = (e: EnumDef): string => {
  const lines = [`  using ${e.name} = ${e.cpp};`];
  for (const v of e.values) lines.push(`  static constexpr ${e.name} ${v.name} = ${e.cpp}_${v.name};`);
  lines.push(
    `  static constexpr ${e.name} ${e.name}_MIN = ${e.cpp}_MIN;`,
    `  static constexpr ${e.name} ${e.name}_MAX = ${e.cpp}_MAX;`,
    `  static constexpr int ${e.name}_ARRAYSIZE = ${e.cpp}_ARRAYSIZE;`,
    `  static bool ${e.name}_IsValid(int value) { return ${e.cpp}_IsValid(value); }`,
    `  template <class T>`,
    `  static const ::std::string& ${e.name}_Name(T value) { return ${e.cpp}_Name(value); }`,
    `  static bool ${e.name}_Parse(::std::string_view name, ${e.name}* value) { return ${e.cpp}_Parse(name, value); }`,
  );
  return lines.join('\n');
};

const genMessage = (m: MessageDef): string => {
  const c = m.cpp;
  const pub: string[] = [];
  const priv: string[] = [];
  const caseOf = (f: FieldDef): string => `_oneof_case_[${f.oneof}]`;
  /** Make f the set member of its oneof. */
  const select = (f: FieldDef): string => (f.oneof >= 0 ? `lb_select_${f.oneof}(${f.number}); ` : '');
  const unselect = (f: FieldDef): string => (f.oneof >= 0 ? ` if (${caseOf(f)} == ${f.number}) ${caseOf(f)} = 0;` : '');

  for (const nested of m.messages) pub.push(`  using ${nested.name} = ${nested.cpp};`);
  for (const e of m.enums) pub.push(nestedEnumAliases(e));

  for (const f of m.fields) {
    const a = accessor(f.name);
    const member = `${a}_`;
    const v = valueType(f);
    pub.push(`  static constexpr int k${camel(f.name)}FieldNumber = ${f.number};`);
    if (f.label === 'map') {
      const value = f.ref !== undefined ? qualified(f.ref) : SCALARS[f.type as Scalar].cpp;
      const map = `${PB}::Map<${SCALARS[f.keyType ?? 'string'].cpp}, ${value}>`;
      priv.push(`  ${map} ${member};`);
      pub.push(
        `  int ${a}_size() const { return static_cast<int>(${member}.size()); }`,
        `  const ${map}& ${a}() const { return ${member}; }`,
        `  ${map}* mutable_${a}() { return &${member}; }`,
        `  void clear_${a}() { ${member}.clear(); }`,
      );
    } else if (f.label === 'repeated') {
      if (f.ref?.kind === 'message' || isStringField(f)) {
        const field = `${PB}::RepeatedPtrField<${v}>`;
        priv.push(`  ${field} ${member};`);
        pub.push(
          `  int ${a}_size() const { return ${member}.size(); }`,
          `  const ${v}& ${a}(int index) const { return ${member}.Get(index); }`,
          `  ${v}* mutable_${a}(int index) { return ${member}.Mutable(index); }`,
          `  ${v}* add_${a}() { return ${member}.Add(); }`,
          `  const ${field}& ${a}() const { return ${member}; }`,
          `  ${field}* mutable_${a}() { return &${member}; }`,
          `  void clear_${a}() { ${member}.Clear(); }`,
        );
        if (isStringField(f)) {
          pub.push(
            `  template <class... A>`,
            `  void set_${a}(int index, A&&... value) { ${member}.Mutable(index)->assign(::std::forward<A>(value)...); }`,
            `  template <class A0, class... A>`,
            `  void add_${a}(A0&& value, A&&... rest) { ${member}.Add()->assign(::std::forward<A0>(value), ::std::forward<A>(rest)...); }`,
          );
        }
      } else {
        const stored = f.ref?.kind === 'enum' ? 'int' : v;
        const field = `${PB}::RepeatedField<${stored}>`;
        priv.push(`  ${field} ${member};`);
        pub.push(
          `  int ${a}_size() const { return ${member}.size(); }`,
          `  ${v} ${a}(int index) const { return static_cast<${v}>(${member}.Get(index)); }`,
          `  void set_${a}(int index, ${v} value) { ${member}.Set(index, value); }`,
          `  void add_${a}(${v} value) { ${member}.Add(value); }`,
          `  const ${field}& ${a}() const { return ${member}; }`,
          `  ${field}* mutable_${a}() { return &${member}; }`,
          `  void clear_${a}() { ${member}.Clear(); }`,
        );
      }
    } else if (f.ref?.kind === 'message') {
      priv.push(`  ${PBI}::MessageSlot ${member};`);
      const has = f.oneof >= 0 ? `${caseOf(f)} == ${f.number}` : `${member}.p != nullptr`;
      pub.push(
        `  bool has_${a}() const { return ${has}; }`,
        `  const ${v}& ${a}() const { return ${PBI}::get<${v}>(${member}); }`,
        `  ${v}* mutable_${a}() { ${select(f)}return ${PBI}::mut<${v}>(${member}); }`,
        `  void clear_${a}() { ${member}.reset();${unselect(f)} }`,
        `  ${v}* release_${a}() {${unselect(f)} return ${PBI}::release<${v}>(${member}); }`,
        `  void set_allocated_${a}(${v}* value) { if (value != nullptr) { ${select(
          f,
        )}} else { clear_${a}(); } ${PBI}::set_allocated<${v}>(${member}, value); }`,
      );
    } else if (isStringField(f)) {
      priv.push(`  ::std::string ${member};`);
      pub.push(
        `  const ::std::string& ${a}() const { return ${member}; }`,
        `  template <class... A>`,
        `  void set_${a}(A&&... value) { ${select(f)}${member}.assign(::std::forward<A>(value)...); }`,
        `  ::std::string* mutable_${a}() { ${select(f)}return &${member}; }`,
        `  void clear_${a}() { ${member}.clear();${unselect(f)} }`,
        `  ::std::string* release_${a}() { auto* out = new ::std::string(::std::move(${member})); clear_${a}(); return out; }`,
        `  void set_allocated_${a}(::std::string* value) { if (value == nullptr) { clear_${a}(); return; } set_${a}(::std::move(*value)); delete value; }`,
      );
      if (f.oneof >= 0) pub.push(`  bool has_${a}() const { return ${caseOf(f)} == ${f.number}; }`);
    } else {
      const enumType = f.ref?.kind === 'enum';
      priv.push(`  ${enumType ? 'int' : v} ${member}{};`);
      pub.push(
        enumType
          ? `  ${v} ${a}() const { return static_cast<${v}>(${member}); }`
          : `  ${v} ${a}() const { return ${member}; }`,
        `  void set_${a}(${v} value) { ${select(f)}${member} = value; }`,
        `  void clear_${a}() { ${member} = {};${unselect(f)} }`,
      );
      if (f.oneof >= 0) pub.push(`  bool has_${a}() const { return ${caseOf(f)} == ${f.number}; }`);
    }
  }

  m.oneofs.forEach((o, index) => {
    const members = m.fields.filter(f => f.oneof === index);
    const resets = members
      .map(f => {
        const member = `${accessor(f.name)}_`;
        if (f.ref?.kind === 'message') return `${member}.reset();`;
        if (isStringField(f)) return `${member}.clear();`;
        return `${member} = {};`;
      })
      .join(' ');
    if (!o.synthetic) {
      const caseType = `${camel(o.name)}Case`;
      pub.push(
        `  enum ${caseType} {`,
        ...members.map(f => `    k${camel(f.name)} = ${f.number},`),
        `    ${o.name.toUpperCase()}_NOT_SET = 0,`,
        `  };`,
        `  ${caseType} ${accessor(o.name)}_case() const { return static_cast<${caseType}>(_oneof_case_[${index}]); }`,
        `  void clear_${accessor(o.name)}() { ${resets} _oneof_case_[${index}] = 0; }`,
      );
    }
    priv.push(
      `  void lb_select_${index}(int number) { if (_oneof_case_[${index}] != number) { ${resets} _oneof_case_[${index}] = number; } }`,
    );
  });
  if (m.oneofs.length > 0) priv.push(`  int _oneof_case_[${m.oneofs.length}] = {};`);

  return `class ${c} final : public ${PB}::Message {
 public:
  ${c}() = default;
  ${c}(const ${c}& from) : ${c}() { CopyFrom(from); }
  ${c}(${c}&&) noexcept = default;
  ${c}& operator=(const ${c}& from) { CopyFrom(from); return *this; }
  ${c}& operator=(${c}&&) noexcept = default;
  static const ${c}& default_instance() { static const ${c} instance; return instance; }
  static const ${PBI}::MessageInfo& lb_type();
  const ${PBI}::MessageInfo& lb_info() const override { return lb_type(); }
  ${c}* New() const override { return new ${c}(); }
  void Swap(${c}* other) { Message::Swap(other); }
${pub.join('\n')}

 private:
${priv.join('\n')}
};
`;
};

/** The field table of a message, defined once every class is complete. */
const genTable = (m: MessageDef): string => {
  const fields = [...m.fields].sort((a, b) => a.number - b.number);
  const rows = fields.map(f => {
    const sub =
      f.ref?.kind === 'message'
        ? `&${qualified(f.ref)}::lb_type, nullptr`
        : f.ref?.kind === 'enum'
        ? `nullptr, &${qualified(f.ref)}_lb_enum`
        : 'nullptr, nullptr';
    const label = f.label === 'map' ? 'kMap' : f.label === 'repeated' ? 'kRepeated' : 'kSingular';
    const key = f.keyType !== undefined ? `, ${PBI}::Type::${SCALARS[f.keyType].kind}` : '';
    return `      {${f.number}, "${f.name}", "${f.jsonName}", ${PBI}::Type::${kindOf(f)}, ${PBI}::Label::${label}, ${
      f.oneof
    }, [](${PB}::MessageLite* m) { return ${PBI}::erase(&static_cast<${m.cpp}*>(m)->${accessor(
      f.name,
    )}_); }, ${sub}${key}},`;
  });
  const cases =
    m.oneofs.length > 0
      ? `, [](${PB}::MessageLite* m) -> int* { return static_cast<${m.cpp}*>(m)->_oneof_case_; }, ${m.oneofs.length}`
      : '';
  const table =
    fields.length > 0
      ? `  static const ${PBI}::FieldInfo fields[] = {\n${rows.join('\n')}\n  };\n`
      : `  static const ${PBI}::FieldInfo* const fields = nullptr;\n`;
  return `inline const ${PBI}::MessageInfo& ${m.cpp}::lb_type() {
${table}  static const ${PBI}::MessageInfo info{"${m.full}", fields, ${fields.length}, []() -> ${PB}::MessageLite* { return new ${m.cpp}(); }${cases}};
  return info;
}
`;
};

/**
 * Classes in an order that compiles: a map's message values (held by value in a std::map) before
 * the message holding the map; otherwise nested messages first, as protoc orders them.
 */
const orderMessages = (file: ProtoFile): MessageDef[] => {
  const out: MessageDef[] = [];
  const done = new Set<MessageDef>();
  const all = allMessages(file.messages);
  const visit = (m: MessageDef, stack: Set<MessageDef>): void => {
    if (done.has(m) || stack.has(m)) return;
    stack.add(m);
    for (const f of m.fields) {
      if (f.label === 'map' && f.ref?.kind === 'message' && f.ref.file === file) visit(f.ref, stack);
    }
    for (const n of m.messages) visit(n, stack);
    stack.delete(m);
    done.add(m);
    out.push(m);
  };
  for (const m of all) visit(m, new Set());
  return out;
};

const banner = (path: string): string =>
  `// Generated by LeetBuild's protogen from ${path}. DO NOT EDIT.\n#pragma once\n`;

const inNamespace = (pkg: string, body: string): string => {
  const ns = namespaceOf(pkg);
  return ns ? `namespace ${ns} {\n\n${body}\n}  // namespace ${ns}\n` : body;
};

const genPbH = (file: ProtoFile): string => {
  const includes = [
    '#include <cstdint>',
    '#include <string>',
    '#include <string_view>',
    '#include <utility>',
    '',
    '#include <google/protobuf/message.h>',
    ...file.imports.filter(i => !i.startsWith('google/protobuf/')).map(i => `#include "${headerName(i, '.pb.h')}"`),
  ];
  const messages = orderMessages(file);
  const body = [
    messages.map(m => `class ${m.cpp};`).join('\n'),
    '',
    ...allEnums(file).map(genEnum),
    ...messages.map(genMessage),
    ...messages.map(genTable),
  ].join('\n');
  return `${banner(file.path)}\n${includes.join('\n')}\n\n${inNamespace(file.pkg, body)}`;
};

const genService = (s: ServiceDef): string => {
  const req = (m: MethodDef): string => qualified(m.inputRef as MessageDef);
  const res = (m: MethodDef): string => qualified(m.outputRef as MessageDef);
  const path = (m: MethodDef): string => `"/${s.full}/${m.name}"`;
  const iface: string[] = [];
  const ifaceRaw: string[] = [];
  const stub: string[] = [];
  const stubRaw: string[] = [];
  const service: string[] = [];
  const register: string[] = [];
  const ctx = '::grpc::ClientContext* context';
  for (const m of s.methods) {
    const n = m.name;
    if (!m.clientStreaming && !m.serverStreaming) {
      iface.push(`    virtual ::grpc::Status ${n}(${ctx}, const ${req(m)}& request, ${res(m)}* response) = 0;`);
      stub.push(
        `    ::grpc::Status ${n}(${ctx}, const ${req(m)}& request, ${res(m)}* response) override {`,
        `      return ::grpc::internal::BlockingUnaryCall(channel_.get(), ${path(m)}, context, request, response);`,
        `    }`,
      );
      service.push(
        `    virtual ::grpc::Status ${n}(::grpc::ServerContext* context, const ${req(m)}* request, ${res(
          m,
        )}* response) {`,
        `      (void)context; (void)request; (void)response;`,
        `      return ::grpc::Status(::grpc::StatusCode::UNIMPLEMENTED, "");`,
        `    }`,
      );
      register.push(
        `      AddMethod(${path(
          m,
        )}, ::grpc::internal::RpcMethod::NORMAL_RPC, ::grpc::internal::UnaryHandler(this, &Service::${n}));`,
      );
      continue;
    }
    let ifaceType: string;
    let stubType: string;
    let params: string;
    let args: string;
    let make: string;
    let handlerParams: string;
    let kind: string;
    let handler: string;
    if (m.serverStreaming && !m.clientStreaming) {
      ifaceType = `::grpc::ClientReaderInterface<${res(m)}>`;
      stubType = `::grpc::ClientReader<${res(m)}>`;
      params = `${ctx}, const ${req(m)}& request`;
      args = 'context, request';
      make = `new ${stubType}(channel_.get(), ${path(m)}, context, request)`;
      handlerParams = `::grpc::ServerContext* context, const ${req(m)}* request, ::grpc::ServerWriter<${res(
        m,
      )}>* writer`;
      kind = 'SERVER_STREAMING';
      handler = 'ServerStreamingHandler';
    } else if (m.clientStreaming && !m.serverStreaming) {
      ifaceType = `::grpc::ClientWriterInterface<${req(m)}>`;
      stubType = `::grpc::ClientWriter<${req(m)}>`;
      params = `${ctx}, ${res(m)}* response`;
      args = 'context, response';
      make = `new ${stubType}(channel_.get(), ${path(m)}, context, response)`;
      handlerParams = `::grpc::ServerContext* context, ::grpc::ServerReader<${req(m)}>* reader, ${res(m)}* response`;
      kind = 'CLIENT_STREAMING';
      handler = 'ClientStreamingHandler';
    } else {
      ifaceType = `::grpc::ClientReaderWriterInterface<${req(m)}, ${res(m)}>`;
      stubType = `::grpc::ClientReaderWriter<${req(m)}, ${res(m)}>`;
      params = ctx;
      args = 'context';
      make = `new ${stubType}(channel_.get(), ${path(m)}, context)`;
      handlerParams = `::grpc::ServerContext* context, ::grpc::ServerReaderWriter<${res(m)}, ${req(m)}>* stream`;
      kind = 'BIDI_STREAMING';
      handler = 'BidiStreamingHandler';
    }
    iface.push(
      `    ::std::unique_ptr<${ifaceType}> ${n}(${params}) { return ::std::unique_ptr<${ifaceType}>(${n}Raw(${args})); }`,
    );
    ifaceRaw.push(`    virtual ${ifaceType}* ${n}Raw(${params}) = 0;`);
    stub.push(
      `    ::std::unique_ptr<${stubType}> ${n}(${params}) { return ::std::unique_ptr<${stubType}>(${n}Raw(${args})); }`,
    );
    stubRaw.push(`    ${stubType}* ${n}Raw(${params}) override { return ${make}; }`);
    service.push(
      `    virtual ::grpc::Status ${n}(${handlerParams}) {`,
      `      return ::grpc::Status(::grpc::StatusCode::UNIMPLEMENTED, "");`,
      `    }`,
    );
    register.push(
      `      AddMethod(${path(
        m,
      )}, ::grpc::internal::RpcMethod::${kind}, ::grpc::internal::${handler}(this, &Service::${n}));`,
    );
  }
  return `class ${s.name} final {
 public:
  static constexpr char const* service_full_name() { return "${s.full}"; }

  class StubInterface {
   public:
    virtual ~StubInterface() = default;
${iface.join('\n')}

   private:
${ifaceRaw.join('\n')}
  };

  class Stub final : public StubInterface {
   public:
    explicit Stub(const ::std::shared_ptr<::grpc::ChannelInterface>& channel, const ::grpc::StubOptions& options = ::grpc::StubOptions())
        : channel_(channel) { (void)options; }
${stub.join('\n')}

   private:
${stubRaw.join('\n')}
    ::std::shared_ptr<::grpc::ChannelInterface> channel_;
  };

  static ::std::unique_ptr<Stub> NewStub(const ::std::shared_ptr<::grpc::ChannelInterface>& channel,
                                         const ::grpc::StubOptions& options = ::grpc::StubOptions()) {
    return ::std::make_unique<Stub>(channel, options);
  }

  class Service : public ::grpc::Service {
   public:
    Service() {
${register.join('\n')}
    }
${service.join('\n')}
  };
};
`;
};

const genGrpcPbH = (file: ProtoFile): string => {
  const includes = [
    '#include <memory>',
    '',
    '#include <grpcpp/grpcpp.h>',
    '',
    `#include "${headerName(file.path, '.pb.h')}"`,
  ];
  return `${banner(file.path)}\n${includes.join('\n')}\n\n${inNamespace(
    file.pkg,
    file.services.map(genService).join('\n'),
  )}`;
};

/** gRPC's health service (grpc/health/v1/health.proto), which course code includes as protoc generates it. */
const HEALTH_PROTO = `syntax = "proto3";
package grpc.health.v1;
message HealthCheckRequest { string service = 1; }
message HealthCheckResponse {
  enum ServingStatus { UNKNOWN = 0; SERVING = 1; NOT_SERVING = 2; SERVICE_UNKNOWN = 3; }
  ServingStatus status = 1;
}
message HealthListRequest {}
message HealthListResponse { map<string, HealthCheckResponse> statuses = 1; }
service Health {
  rpc Check(HealthCheckRequest) returns (HealthCheckResponse);
  rpc List(HealthListRequest) returns (HealthListResponse);
  rpc Watch(HealthCheckRequest) returns (stream HealthCheckResponse);
}
`;

/**
 * The headers for a set of .proto files (paths as the files are known to each other's imports):
 * `x.proto` gives `x.pb.h` and `x.grpc.pb.h`; gRPC's health service comes along. Throws a
 * ProtoError for what it cannot read.
 */
export function generateCppProtos(protos: Record<string, string>): Record<string, string> {
  const sources: Record<string, string> = {'grpc/health/v1/health.proto': HEALTH_PROTO, ...protos};
  const files = Object.entries(sources).map(([path, text]) => parseFile(path, text));
  resolveAll(files);
  const out: Record<string, string> = {};
  for (const f of files) {
    out[headerName(f.path, '.pb.h')] = genPbH(f);
    out[headerName(f.path, '.grpc.pb.h')] = genGrpcPbH(f);
  }
  return out;
}
