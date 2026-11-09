// Log lines carry ids and counts, never funding text or a name
// (docs/constraints/personal-data.md). Each line is one JSON object, which
// CloudWatch Logs reads as fields.
type Field = string | number | boolean;

function write(level: string, event: string, fields: Record<string, Field>) {
  console.log(JSON.stringify({ level, event, ...fields }));
}

export const logger = {
  info: (event: string, fields: Record<string, Field> = {}) => {
    write("info", event, fields);
  },
  warn: (event: string, fields: Record<string, Field> = {}) => {
    write("warn", event, fields);
  },
};
