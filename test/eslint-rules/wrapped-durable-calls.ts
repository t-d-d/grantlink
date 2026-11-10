// Ways to write a call to one of the SDK's durable operations on `ctx`
// through a TypeScript wrapper, optional chaining (#428) or the comma
// operator around the whole call (#452). Each takes the operation's name and
// the text of its arguments and gives the whole call, so a rule's tests can
// write `await ${shape.call("step", args)}`.
//
// The comma operator around the callee, `(0, ctx.step)(...)`, is not listed.
// It calls the method with no `this`, and the SDK's operations read their
// context from `this`, so the call throws before it runs anything. There is
// no durable call there for a rule to treat as one.
export interface WrappedDurableCall {
  name: string;
  call: (method: string, args: string) => string;
}

export const WRAPPED_DURABLE_CALLS: readonly WrappedDurableCall[] = [
  {
    name: "a callee asserted with as",
    call: (m, a) => `(ctx.${m} as any)(${a})`,
  },
  {
    name: "a callee asserted with angle brackets",
    call: (m, a) => `(<any>ctx.${m})(${a})`,
  },
  {
    name: "a callee checked with satisfies",
    call: (m, a) => `(ctx.${m} satisfies unknown)(${a})`,
  },
  {
    name: "a callee with a non-null assertion",
    call: (m, a) => `ctx.${m}!(${a})`,
  },
  {
    name: "a callee given type arguments",
    call: (m, a) => `(ctx.${m}<number>)(${a})`,
  },
  {
    name: "an optional receiver",
    call: (m, a) => `ctx?.${m}(${a})`,
  },
  {
    name: "an optional call",
    call: (m, a) => `ctx.${m}?.(${a})`,
  },
  {
    name: "a call asserted with as",
    call: (m, a) => `(ctx.${m}(${a}) as Promise<number>)`,
  },
  {
    name: "a call asserted with angle brackets",
    call: (m, a) => `(<Promise<number>>ctx.${m}(${a}))`,
  },
  {
    name: "a call checked with satisfies",
    call: (m, a) => `(ctx.${m}(${a}) satisfies Promise<number>)`,
  },
  {
    name: "a call with a non-null assertion",
    call: (m, a) => `ctx.${m}(${a})!`,
  },
  {
    name: "a call after the comma operator",
    call: (m, a) => `(0, ctx.${m}(${a}))`,
  },
  {
    name: "a call asserted with as after the comma operator",
    call: (m, a) => `(0, ctx.${m}(${a}) as Promise<number>)`,
  },
  {
    name: "layers of wrappers on the call and the callee",
    call: (m, a) => `((ctx?.${m} as any)!(${a}) as Promise<number>)`,
  },
];
