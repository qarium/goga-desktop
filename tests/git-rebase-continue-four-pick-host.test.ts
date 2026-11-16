import {installGitFixtureScope} from "./helpers/git-test-scope";
import {registerFourPickContinuations} from "./helpers/rebase-continuation-fixture";
const fixtureScope=installGitFixtureScope();
registerFourPickContinuations(fixtureScope,["primary","managed"]);
