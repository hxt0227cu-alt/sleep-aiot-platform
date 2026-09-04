import { readFileSync } from "fs";
import Ajv2020, { AnySchema, ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

export function compileTelemetrySchema(schemaPath: string): ValidateFunction {
  return compileTelemetrySchemaDocument(JSON.parse(readFileSync(schemaPath, "utf8")));
}

export function compileTelemetrySchemaDocument(schema: AnySchema): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}
