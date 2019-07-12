const debug = require('./debug')('Puppet');
const Promise = require('bluebird');
const matrixSdk = require("matrix-js-sdk");
const fs = require('fs');
const readFile = Promise.promisify(fs.readFile);
const writeFile = Promise.promisify(fs.writeFile);
const read = Promise.promisify(require('read'));
const utils = require('./utils');
const yaml = require('js-yaml');
const whyPuppeting = 'https://github.com/kfatehi/matrix-appservice-imessage/commit/8a832051f79a94d7330be9e252eea78f76d774bc';

/**
 * Puppet class
 */
class Puppet {
  /**
   * Constructs a Puppet
   *
   * @param {Object} args options
   * @param {Object} args.config puppet bridge config data
   * @param {string} args.configPath path to config file
   * @param {string} args.configFormat "json" (legacy) or "yaml"
   */
  constructor(args) {
    this.id = null;
    this.client = null;
    this.thirdPartyRooms = {};
    this.app = null;

    if (typeof args === "string") {
      // legacy compatibility fallback
      this.config = {
        path: args,
        format: "json"
      };
    } else {
      this.config = {
        data: args.config,
        path: args.configPath,
        format: args.configFormat
      };
    }
  }

  static parseMxid(userId) {
    let matches = /^(.*?):(.*)$/.exec(userId);
    if (matches !== null) {
      return {
        localpart: matches[1],
        domain: matches[2]
      };
    } else {
      throw new Error("Invalid MXID");
    }
  }

  static configSchemaProperties() {
    return {
      puppet: {
        type: "object",
        properties: {
          id: "string",
          token: "string"
        }
      },
      bridge: {
        type: "object",
        properties: {
          homeserverUrl: "string",
        }
      }
    };
  }

  static detectConfigPath() {
    const nopt = require('nopt');
    const path = require('path');
    nopt.invalidHandler = false;
    const args = nopt({
        config: path
    }, {
        c: "--config",
    });

    return args.config;
  }

  async getConfig() {
    if (typeof this.config.data !== "object") {
      const buffer = await readFile(this.config.path);
      if (this.config.format === "json") {
        this.config.data = JSON.parse(buffer).puppet;
      } else {
        this.config.data = yaml.safeLoad(buffer).puppet;
      }
    }

    return this.config.data;
  }

  /**
   * Reads the config file, creates a matrix client, connects, and waits for sync
   *
   * @returns {Promise} Returns a promise resolving the MatrixClient
   */
  async startClient() {
    const { info, warn } = debug(this.startClient.name);
    const config = await this.getConfig();
    this.id = config.puppet.id;
    this.client = matrixSdk.createClient({
      baseUrl: config.bridge.homeserverUrl,
      userId: config.puppet.id,
      accessToken: config.puppet.token
    });
    this.client.startClient();

    this.matrixRoomMembers = {};

    this.client.on("RoomState.members", (event, state, _member) => {
      this.matrixRoomMembers[state.roomId] = Object.keys(state.members);
    });

    this.client.on("Room.receipt", (event, room) => {
      if (this.app === null) {
        return;
      }

      if (room.roomId in this.thirdPartyRooms) {
        let content = event.getContent();
        for (var eventId in content) {
          for (var userId in content[eventId]['m.read']) {
            if (userId === this.id) {
              info("Receive a read event from ourself");
              return this.app.sendReadReceiptAsPuppetToThirdPartyRoomWithId(this.thirdPartyRooms[room.roomId]);
            }
          }
        }
      }
    });

    let isSynced = false;
    this.client.on('sync', (state) => {
      if ( state === 'PREPARED' ) {
        info('synced');
        isSynced = true;
      }
    });

    await utils.until(() => !isSynced);
  }

  /**
   * Get the list of matrix room members
   *
   * @param {string} roomId matrix room id
   * @returns {Array} List of room members
   */
  getMatrixRoomMembers(roomId) {
    return this.matrixRoomMembers[roomId] || [];
  }

  /**
   * Returns the MatrixClient
   *
   * @returns {MatrixClient} an instance of MatrixClient
   */
  getClient() {
    return this.client;
  }

  /**
   * Prompts user for credentials and updates the puppet section of the config
   *
   * @param {Object} args options
   * @param {boolean} args.detectConfigPath infer bridge config from argv
   * @param {AppServiceRegistration} args.registration app service registration
   *
   * @returns {Promise}
   */
  async associate(args) {
    const { info, warn } = debug(this.associate.name);

    info([
      'This bridge performs matrix user puppeting.',
      'This means that the bridge logs in as your user and acts on your behalf',
      'For the rationale, see '+whyPuppeting
    ].join('\n'));

    const args_ = args !== undefined ? args : { };
    const reg = args_.registration;

    const config = await this.getConfig();

    const userId = config.puppet !== undefined && config.puppet.id !== undefined ?
      config.puppet.id : await (async () => {
        console.error("Enter your user id");
        return await read({ silent: false });
    })();

    const homeserver = config.bridge !== undefined && config.bridge.homeserverUrl !== undefined ?
      config.bridge.homeserverUrl : await (async () => {
        const findHome = async (domain) => {
          info(`Searching for homeserver at ${domain}`);
          const clientConfig = await matrixSdk.AutoDiscovery.findClientConfig(domain);
          const hs = clientConfig["m.homeserver"];
          if (hs.state !== "SUCCESS") {
            throw hs.error;
          }
          info(`Found homeserver at ${hs.base_url}`);
          return hs.base_url;
        };

        try {
          let { localpart, domain } = Puppet.parseMxid(userId);
          return findHome(domain);
        } catch (ex) {
          console.error("Enter your matrix homeserver URL");
          const homeserver = await read({ silent: false });
          try {
            // validate the URL parses
            return `${new URL(homeserver)}`;
          } catch (ex) {
            // otherwise last-ditch attempt to treat it as a domain
            return findHome(homeserver);
          }
        }
    })();

    const { homeserverUrl, id, token } = config.puppet !== undefined && config.puppet.token !== undefined ? {
      homeserverUrl: homeserver,
      id: userId,
      token: config.puppet.token
    } : await (async () => {
        console.error(`Enter password for ${userId}`);
        const password = await read({ silent: true, replace: '*' });
        let client = matrixSdk.createClient(homeserver);
        const accessDat = await client.login("m.login.password", {
          user: userId,
          password: password,
          initial_device_display_name: reg !== undefined ? reg.getSenderLocalpart() : undefined
        });
        info("log in success");
        return {
          token: accessDat.access_token,
          id: accessDat.user_id || userId,
          homeserverUrl: accessDat.well_known !== undefined ? accessDat.well_known["m.homeserver"] : homeserver
        };
    })();

    if (config.puppet === undefined || config.bridge === undefined || config.puppet.id !== id || config.puppet.token !== token || config.bridge.homeserverUrl !== homeserver) {
      const puppetConfig = {
        puppet: {
          id: id,
          token: token
        },
        bridge: {
          homeserverUrl: homeserver
        }
      };
      const newConfig = Object.assign(config, puppetConfig);

      const configPath = this.config.path !== undefined ? this.config.path :
        (args_.detectConfigPath ? Puppet.detectConfigPath() : undefined);
      if (configPath !== undefined) {
        await writeFile(configPath, (() => {
          if (this.config.format === "json") {
            return JSON.stringify(newConfig, null, 2);
          } else {
            return yaml.safeDump(newConfig);
          }
        })());
        info(`Updated config file ${configPath}`);
      } else {
        warn('Please update your bridge config');
        console.log(yaml.safeDump(puppetConfig));
      }
    }
  }

  /**
   * Save a third party room id
   *
   * @param {string} matrixRoomId matrix room id
   * @param {string} thirdPartyRoomId third party room id
   */
  saveThirdPartyRoomId(matrixRoomId, thirdPartyRoomId) {
    this.thirdPartyRooms[matrixRoomId] = thirdPartyRoomId;
  }

  /**
   * Set the App object
   *
   * @param {MatrixPuppetBridgeBase} app the App object
   */
  setApp(app) {
    this.app = app;
  }
}

module.exports = Puppet;
