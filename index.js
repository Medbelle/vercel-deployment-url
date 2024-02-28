const fetch = require("node-fetch");
const core = require("@actions/core");
const { Octokit } = require("@octokit/rest");

const DEPLOYMENT_SEARCH_INTERVAL = 5;
const DEPLOYMENT_READY_INTERVAL = 30;

async function wait(s) {
  return new Promise((resolve) => setTimeout(resolve, s * 1000));
}

async function main() {
  const githubToken = core.getInput("github-token", { required: true });
  const vercelToken = core.getInput("vercel-token", { required: true });
  const projectId = core.getInput("project-id", { required: true });
  const teamId = core.getInput("team-id");
  const searchRetries = parseInt(core.getInput("search-retries"), 10) || 3;
  const readyRetries = parseInt(core.getInput("ready-retries"), 10) || 10;

  const octokit = new Octokit({ auth: githubToken });
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

  async function api(path) {
    const res = await fetch(`https://api.vercel.com${path}`, {
      headers: {
        authorization: `Bearer ${vercelToken}`,
      },
    });
    const json = await res.json();
    if (!res.ok) {
      console.error(json);
      throw new Error(
        "Something went wrong while trying to fetch deployments from the Vercel API, see the error above."
      );
    }
    return json;
  }

  async function findLatestSuccessfulDeployment(branchName) {
    const { deployments } = await api(
      `/v6/now/deployments?${
        teamId ? `teamId=${teamId}&` : ""
      }projectId=${projectId}&state=READY&meta-githubCommitRef=${branchName}&limit=1`
    );

    if (Array.isArray(deployments) && deployments.length > 0) {
      console.log(
        `Found ${deployments.length} deployment${
          deployments.length > 1 ? "s" : ""
        }, using the latest one.`
      );
      return api(
        `/v13/deployments/${deployments[0].uid}${
          teamId ? `?teamId=${teamId}&withGitRepoInfo=true&` : ""
        }`
      );
    } else {
      return null
    }
  }

  async function findLatestDeployment(commitSha, retries) {
    if (typeof retries !== "number" || retries <= 0) {
      return null;
    }

    console.log(`Searching for deployments related to commit ${commitSha}.`);
    const { deployments } = await api(
      `/v6/now/deployments?${
        teamId ? `teamId=${teamId}&` : ""
      }projectId=${projectId}&meta-githubCommitSha=${commitSha}`
    );

    if (Array.isArray(deployments) && deployments.length > 0) {
      console.log(
        `Found ${deployments.length} deployment${
          deployments.length > 1 ? "s" : ""
        }, using the latest one.`
      );
      return api(
        `/v13/deployments/${deployments[0].uid}${
          teamId ? `?teamId=${teamId}&withGitRepoInfo=true&` : ""
        }`
      );
    }
    console.log(
      `No deployments found yet, waiting for ${DEPLOYMENT_SEARCH_INTERVAL} seconds before trying again (${retries} retries remaining)`
    );
    await wait(DEPLOYMENT_SEARCH_INTERVAL);
    return findLatestDeployment(commitSha, retries - 1);
  }

  async function findDeployment(commitSha, numberOfRecursiveCalls) {
    const deployment = await findLatestDeployment(
      commitSha,
      numberOfRecursiveCalls === 0 ? searchRetries : 1
    );

    if (deployment) {
      return deployment;
    }

    try {
      const commit = await octokit.repos.getCommit({
        owner,
        repo,
        ref: commitSha,
      });
      if (commit.data.parents[1]) {
        
        return findDeployment(
          commit.data.parents[1].sha,
          numberOfRecursiveCalls + 1
        );
      }
      return null;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  const commitSha = process.env.TARGET_COMMIT || process.env.GITHUB_SHA;
  const targetBranchName = process.env.TARGET_BRANCH;

  async function waitForDeploymentToBeReady(deployment, retries) {
    if (typeof retries !== "number" || retries <= 0) {
      throw new Error(
        "The Vercel deployment is still not ready after running out of retries."
      );
    }
    console.log("deployment.readyState", deployment.readyState)
    switch (deployment.readyState) {
      case "READY":
        console.log(`The deployment is ready under ${deployment.url}.`);
        return deployment;
      case "ERROR":
        throw new Error("The Vercel deployment did not succeed.");
      case "CANCELED":
        // If the deployment was canceled and there's a target github branch name in environment
        // we will check if there is a previous successful deployment
        const previousDeployment = targetBranchName ? await findLatestSuccessfulDeployment(targetBranchName) : null
        return previousDeployment
      case "QUEUED":
      case "BUILDING":
      default:
        console.log(
          `The latest deployment is still in the '${deployment.readyState}' state, waiting for ${DEPLOYMENT_READY_INTERVAL} more seconds (${retries} retries remaining)`
        );
        await wait(DEPLOYMENT_READY_INTERVAL);
        const updatedDeployment = await api(
          `/v13/deployments/${deployment.id}${
            teamId ? `?teamId=${teamId}&withGitRepoInfo=true&` : ""
          }`
        );
        return waitForDeploymentToBeReady(updatedDeployment, retries - 1);
    }
  }

  const deployment = await findDeployment(commitSha, 0);
  if (!deployment) {
    throw new Error(
      `Could not find any Vercel deployments for the commit with SHA ${commitSha}.`
    );
  }

  const readyDeployment = await waitForDeploymentToBeReady(
    deployment,
    readyRetries
  );

  if (readyDeployment && readyDeployment.url) {
    console.log(`The deployment is ready under ${readyDeployment.url}.`);
    core.info("url:", readyDeployment.url);
    core.info("id:", readyDeployment.id);
    core.info("name:", readyDeployment.name);
    core.info("branch:", readyDeployment.gitSource?.ref);
    
    core.setOutput("url", readyDeployment.url);
    core.setOutput("id", readyDeployment.id);
    core.setOutput("name", readyDeployment.name);
    core.setOutput("branchName", readyDeployment.gitSource?.ref);
  }
}

main().catch((error) => {
  core.setFailed(error.message);
});
