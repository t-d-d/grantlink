# Hosting
Relevance: serverless.yml, infra/site.cfn.yml, the app stack's resources or region, .github/workflows/deploy.yml, or anything that runs or serves in AWS
Decision: grantlink runs serverless in AWS London (eu-west-2), in its own account. The page is S3 behind CloudFront, HTTPS only, and nothing is always on.

Why: Stored funding text names people, and keeping it in London keeps it
in the UK. The pipeline runs once a week and the page is static, so
anything that runs between runs costs money and needs patching for no
gain. Serving a public page over plain HTTP lets anyone on the path change
what a visitor reads.

## Rules

- The app stack is `grantlink-prod`, from `serverless.yml`, in eu-west-2.
  It is the only stack the deploy role may change.
- The deploy never names a region or a stage on the command line, so
  `serverless.yml` alone decides where the stack goes.
- The app stack declares no EC2 instance, ECS service, NAT gateway,
  database server or provisioned concurrency.
- The page's bucket blocks all public access and has no website endpoint.
  CloudFront reads it through origin access control.
- CloudFront sends every plain HTTP request to HTTPS, and tells browsers
  to keep to HTTPS.
- The page is served at grantlink.uk. The app stack reads the
  certificate's ARN and the zone's id from the `dns` stack in us-east-1 at
  deploy time, so a deploy before the DNS stack exists fails. It never
  falls back to CloudFront's own address.
- The DNS stack and the roles stack sit in us-east-1, apart from the app
  stack, and the owner applies them by hand. Deleting the app stack never
  changes the nameservers.

## Do not

- Publish the page from a scheduled GitHub Actions workflow to GitHub
  Pages. It is simpler and free, but it has no alarms and shows nothing
  about running a service on a cloud platform.
- Run the pipeline on Fargate or a small VM. It costs money while idle and
  needs patching, for no gain at weekly volume.
- Put the app stack in us-east-1 to match the DNS stack. Stored funding
  text, names included, would sit in the US.
- Share an account with other projects. It mixes permissions and spend.
- Serve the bucket's website endpoint. It speaks plain HTTP only.

## Judgment

The static checks read the templates. A setting changed in the console
does not show there, and only the app stack should change the account.
The live tier checks after each deploy that plain HTTP is sent to HTTPS.

History: #4, #44
