import {installGitFixtureScope} from "./helpers/git-test-scope";
import {registerContinuationRoundtrips} from "./helpers/rebase-continuation-fixture";
const fixtureScope=installGitFixtureScope();
registerContinuationRoundtrips(fixtureScope,["managed"]);
