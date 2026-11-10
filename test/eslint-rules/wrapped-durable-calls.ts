// Ways to write a call to one of the SDK's durable operations on `ctx`
// through a TypeScript wrapper or optional chaining (#428). Each takes the
// operation's name and the text of its arguments and gives the whole call,
// so a rule's tests can write `await ${shape.call("step", args)}`.
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
    name: "layers of wrappers on the call and the callee",
    call: (m, a) => `((ctx?.${m} as any)!(${a}) as Promise<number>)`,
  },
];
