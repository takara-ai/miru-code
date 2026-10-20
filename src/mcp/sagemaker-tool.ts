import * as z from "zod";
import { saveStoredCredentials } from "../credentials.ts";
import { parseSageMakerEndpointArn, validateSageMakerConnection } from "../embeddings/sagemaker.ts";
import { toolText } from "./index-cache.ts";
import type { MiruMcpServer } from "./runtime.ts";

export function registerSageMakerTool(
  server: MiruMcpServer,
  options: {
    onConfigured: () => void;
    validateConnection?: typeof validateSageMakerConnection;
  },
): void {
  server.registerTool(
    "configure_sagemaker",
    {
      description:
        "On user request, validate and save a SageMaker endpoint with an existing AWS profile, replacing stored credentials.",
      inputSchema: {
        endpoint_arn: z.string().trim().min(1),
        aws_profile: z.string().trim().min(1),
      },
    },
    async ({ endpoint_arn: endpointArn, aws_profile: profile }) => {
      try {
        const pluginArn = process.env.MIRU_PLUGIN_SAGEMAKER_ENDPOINT_ARN?.trim();
        if (pluginArn && !(pluginArn.startsWith("${") && pluginArn.endsWith("}"))) {
          throw new Error(
            "SageMaker is controlled by this host's plugin settings. " +
              "Change or clear the endpoint ARN and AWS profile there first.",
          );
        }
        const { endpointName, region } = parseSageMakerEndpointArn(endpointArn);
        const result = await (options.validateConnection ?? validateSageMakerConnection)({
          endpointName,
          region,
          profile,
          normalize: true,
          truncate: true,
          truncationDirection: "Right",
        });
        if (!result.valid) {
          return { ...toolText(result.message), isError: true };
        }
        await saveStoredCredentials({ kind: "sagemaker", endpointArn, profile });
        options.onConfigured();
        return toolText(
          `Miru now embeds via SageMaker endpoint ${endpointName} in ${region} ` +
            `(AWS profile: ${profile}). Configuration saved for this plugin. ` +
            "The index will reload on the next search.",
        );
      } catch (err) {
        return { ...toolText(err instanceof Error ? err.message : String(err)), isError: true };
      }
    },
  );
}
