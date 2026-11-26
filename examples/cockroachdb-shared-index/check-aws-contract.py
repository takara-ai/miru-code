"""Exercise CloudFormation packaging and Miru's SageMaker client against Moto."""
import json
import os
from pathlib import Path
from subprocess import run
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen

import boto3
from moto.server import ThreadedMotoServer

pilot = Path(__file__).with_name("pilot.yml").resolve()
bucket = "miru-box-template-fixtures"
region = "us-east-1"
server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
server.start()
try:
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    session = boto3.Session(
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        region_name=region,
    )
    env = {
        **os.environ,
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_REGION": region,
        "AWS_DEFAULT_REGION": region,
        "AWS_EC2_METADATA_DISABLED": "true",
        "AWS_ENDPOINT_URL": endpoint,
        "AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME": endpoint,
    }
    s3 = session.client("s3", endpoint_url=endpoint)
    s3.create_bucket(Bucket=bucket)
    with TemporaryDirectory() as work:
        packaged = Path(work, "pilot-packaged.yml")
        run(
            [
                "aws", "cloudformation", "package",
                "--template-file", str(pilot),
                "--s3-bucket", bucket,
                "--output-template-file", str(packaged),
            ],
            env=env,
            check=True,
        )
        objects = s3.list_objects_v2(Bucket=bucket).get("Contents", [])
        assert len(objects) == 2, "Expected both child templates to be packaged"
        cloudformation = session.client("cloudformation", endpoint_url=endpoint)
        result = cloudformation.validate_template(TemplateBody=packaged.read_text())
        assert any(
            p["ParameterKey"] == "ModelPackageArn" for p in result["Parameters"]
        )

    fixture = [1] + [0] * 255
    body = json.dumps({
        "region": region,
        "results": [{
            "Body": json.dumps({"embeddings": [fixture]}),
            "ContentType": "application/json",
            "InvokedProductionVariant": "AllTraffic",
        }],
    }).encode("utf-8")
    request = Request(
        f"{endpoint}/moto-api/static/sagemaker/endpoint-results",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=10) as response:
        assert response.status == 200
    run(
        ["bun", "-e", """
import { createSageMakerClient } from "./src/embeddings/sagemaker.ts";
const client = createSageMakerClient({
  endpointName: "miru-box-fixture",
  region: "us-east-1",
  normalize: true,
  truncate: true,
  truncationDirection: "Right",
});
const response = await client.createEmbeddings(["export const boxed = true"], "ds1-code", 256);
const embedding = response.data[0]?.embedding;
if (!Array.isArray(embedding) || embedding.length !== 256 ||
    embedding[0] !== 1 || embedding.slice(1).some((value) => value !== 0)) {
  throw new Error("Unexpected SageMaker fixture response.");
}
"""],
        cwd=pilot.parents[2],
        env=env,
        check=True,
    )
    print("Packaged both nested templates and invoked the Moto SageMaker Runtime.")
finally:
    server.stop()
