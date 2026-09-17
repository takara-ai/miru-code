import { describe, expect, test } from "bun:test";
import { parseCaseInsensitiveStaticCredentials } from "../src/embeddings/sagemaker.ts";

describe("SageMaker AWS profile compatibility", () => {
  test("accepts uppercase static credential keys in AWS profile files", () => {
    const credentials = parseCaseInsensitiveStaticCredentials(
      "[profile miru]\nregion = eu-west-2\n",
      "[miru]\nAWS_ACCESS_KEY_ID = AKIAEXAMPLE\nAWS_SECRET_ACCESS_KEY = secret\n",
      "miru",
    );

    expect(credentials).toEqual({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: undefined,
    });
  });

  test("merges config and credentials files case-insensitively", () => {
    const credentials = parseCaseInsensitiveStaticCredentials(
      "[PROFILE MIRU]\nAWS_ACCESS_KEY_ID = AKIAEXAMPLE\nregion = eu-west-2\n",
      "[MIRU]\naws_secret_access_key = secret\n",
      "miru",
    );

    expect(credentials?.accessKeyId).toBe("AKIAEXAMPLE");
    expect(credentials?.secretAccessKey).toBe("secret");
  });

  test("does not treat a non-static profile as static credentials", () => {
    const credentials = parseCaseInsensitiveStaticCredentials(
      "[profile miru]\nrole_arn = arn:aws:iam::123456789012:role/Miru\n",
      "",
      "miru",
    );

    expect(credentials).toBeNull();
  });
});
