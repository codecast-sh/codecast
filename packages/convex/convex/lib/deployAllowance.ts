// The line's deploy allowance (docs/architecture/deploys.md DP4): the role's
// `deploy` authority grant (org-hire.md H4: kind publish, a per_day limit)
// and today's count against it. The rule lives in the shared contract, so
// the trigger here and the Deploys view read one answer.
export { DEPLOY_AUTHORITY_ID, DEPLOY_AUTHORITY_KIND, DEPLOY_AUTHORITY_LABEL, deployAllowance, deployGrantOf, type DeployAllowance } from "@codecast/shared/contracts/deployAuthority";
