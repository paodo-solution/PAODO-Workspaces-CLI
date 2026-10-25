// The command tree, noun before verb (`paodo drive file cat` is commands/file/cat.mjs); help is in src/help.mjs.
// commands/file/ is mounted under both workspace and drive; every command calls a route the CLI token may use.
import appModels from "./app/models.mjs";
import appStatus from "./app/status.mjs";
import connectionCreate from "./connection/create.mjs";
import connectionLs from "./connection/ls.mjs";
import connectionRm from "./connection/rm.mjs";
import driveCreate from "./drive/create.mjs";
import driveGet from "./drive/get.mjs";
import driveLs from "./drive/ls.mjs";
import driveRm from "./drive/rm.mjs";
import driveSet from "./drive/set.mjs";
import { DRIVE, WORKSPACE, fileGroup } from "./file/group.mjs";
import conversationLs from "./workspace/conversation/ls.mjs";
import conversationSessionCallLs from "./workspace/conversation/session/call/ls.mjs";
import conversationSessionCallShow from "./workspace/conversation/session/call/show.mjs";
import conversationSessionLs from "./workspace/conversation/session/ls.mjs";
import conversationSessionShow from "./workspace/conversation/session/show.mjs";
import keyGenerate from "./workspace/key/generate.mjs";
import keyRevoke from "./workspace/key/revoke.mjs";
import keyRotate from "./workspace/key/rotate.mjs";
import scheduleGet from "./workspace/schedule/get.mjs";
import scheduleSet from "./workspace/schedule/set.mjs";
import workspaceCreate from "./workspace/create.mjs";
import workspaceGet from "./workspace/get.mjs";
import workspaceLs from "./workspace/ls.mjs";
import workspaceRm from "./workspace/rm.mjs";
import workspaceSet from "./workspace/set.mjs";

// A group node has only `commands`. A leaf has `run`, `min` and `max` — and, if it takes any, `options`
// — all from its own file. Neither carries help text; see src/help.mjs.
export const ROOT = {
  commands: {
    app: {
      commands: {
        status: appStatus,
        models: appModels,
      },
    },
    workspace: {
      commands: {
        ls: workspaceLs,
        get: workspaceGet,
        create: workspaceCreate,
        set: workspaceSet,
        rm: workspaceRm,
        key: {
          commands: {
            generate: keyGenerate,
            rotate: keyRotate,
            revoke: keyRevoke,
          },
        },
        schedule: {
          commands: {
            get: scheduleGet,
            set: scheduleSet,
          },
        },
        conversation: {
          commands: {
            ls: conversationLs,
            session: {
              commands: {
                ls: conversationSessionLs,
                show: conversationSessionShow,
                call: {
                  commands: {
                    ls: conversationSessionCallLs,
                    show: conversationSessionCallShow,
                  },
                },
              },
            },
          },
        },
        file: fileGroup(WORKSPACE),
      },
    },
    drive: {
      commands: {
        ls: driveLs,
        get: driveGet,
        create: driveCreate,
        set: driveSet,
        rm: driveRm,
        file: fileGroup(DRIVE),
      },
    },
    // A noun of its own because an edge belongs to neither end of it: filed under `workspace` it would
    // be missing from `drive --help`, and written under both it would be one listing with two names.
    connection: {
      commands: {
        ls: connectionLs,
        create: connectionCreate,
        rm: connectionRm,
      },
    },
  },
};
