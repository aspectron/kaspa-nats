#! /usr/bin/env node

const cliProgress = require('cli-progress');
const { Command } = require('commander');
const { Wallet, initKaspaFramework, log : walletLogger, Storage, FlowLogger} = require('@kaspa/wallet');
const { RPC } = require('@kaspa/grpc-node');
const { delay, dpc, debounce, clearDPC } = require('@aspectron/flow-async');
const FlowUid = require('@aspectron/flow-uid');
const Decimal = require('decimal.js');
const fs = require("fs");
const os = require("os");
const mkdirp = require('mkdirp');
const path = require("path");
const ReadLine = require('readline');
const Writable = require('stream').Writable;
const qrcode = require('qrcode-terminal');
const program = new Command();
const storage = new Storage({logLevel:'debug'});
const NATS = require('nats');
const jc = NATS.JSONCodec();
const pkg = require('./package.json');
const KaspaSim = require('./lib/kaspa-sim');
const Task = require('./lib/task');
const log = new FlowLogger('Kaspa', {
	display : ['level','time','name'],
	color: ['level', 'content']
});

function hasData(msg) {
    if(!msg.data) {
        log.error(`missing data in ${msg.subject}`);
        return false;
    }
    return true;
}

// let g_daemon = null;
// let g_currentTask = null;

class KaspaNATS {

	constructor() {
		this.log = 'info';

        this.dataFolder = path.join(os.homedir(),'.kaspa');
        const uidFile = path.join(this.dataFolder,'kaspa-nats.uid');
        if(!fs.existsSync(uidFile)) {
            this.uid = FlowUid({ length : 8 });
            mkdirp.sync(this.dataFolder);
            fs.writeFileSync(uidFile,this.uid,{encoding:'utf8'});
        } else {
            this.uid = fs.readFileSync(uidFile,{encoding:'utf8'});
        }
        log.info('Kaspa NATS interface UID',this.uid.yellow);

	}

	async init() {
		await initKaspaFramework();
	}

	get options() {
		if(!this._options) {
			this._options = program.opts();
			Object.entries(this._options).forEach(([k,v])=>{ if(v === undefined) delete this._options[k]; });
		}
		return this._options;
	}

	get network() {
		const { options } = this;
		const aliases = Object.keys(Wallet.networkAliases);
		for(let n of aliases)
			if(options[n]) return Wallet.networkAliases[n];
		return 'kaspa';
	}

	get rpc() {
		if(this.rpc_)
			return this.rpc_;
		const { network, options, uid } = this;
		const { port } = Wallet.networkTypes[network];
		const host = options.grpcServer || `127.0.0.1:${port}`;
		this.rpc_ = new RPC({ clientConfig:{ host, reconnect : false, verbose : false } });
		this.rpc_.onConnectFailure((reason)=>{
			const msg = `gRPC - no connection to ${Wallet.networkTypes[network].name} at ${host} (${reason})`;
            this.nats.publish('KASPA.wallet.error', jc.encode({uid, msg}));
			if(this.isNetworkSync) {
				switch(this.syncState) {
					case 'connect': {
						log.error(msg);
					} break;
					case 'init':
					case 'wait': {
						console.log('');
						log.error(msg);
						process.exit(1);
					} break;
					default: {
						console.log('');
						log.error(msg);
						this.resetNetworkSync = true;
					} break;
				}
			}
		});
		//if(this._options.log == 'info')
		//    this.rpc_.client.verbose = true;
		return this.rpc_;
	}

	get rpcIsActive() { return !!this.rpc_; }

	KAS(v, pad = 0) {
		let [int,frac] = Decimal(v||0).mul(1e-8).toFixed(8).split('.');
		int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",").padStart(pad,' ');
		frac = frac.replace(/0+$/,'');
		return frac ? `${int}.${frac}` : int;
	}


	setupLogs(wallet){
		const level = (this.options.verbose&&'verbose')||(this.options.debug&&'debug')||(this.options.log)||'info';
		wallet.setLogLevel(level);
        wallet.logger.relayTo(this.logSink.bind(this))
		walletLogger.level = level;
        walletLogger.relayTo(this.logSink.bind(this));
	}

    logSink(log) {
        const { uid } = this;
        this.nats.publish('KASPA.log',jc.encode({uid, log}));


    }


	openWallet() {
		return new Promise(async (resolve, reject) => {
			let walletMeta = await storage.getWallet();
			if(!walletMeta || !walletMeta.wallet?.mnemonic){
				return reject("Please create wallet")
			}

			if(walletMeta.encryption=='none'){
				const { network, rpc } = this;
				let wallet = Wallet.fromMnemonic(walletMeta.wallet.mnemonic, { network, rpc });
				return resolve(wallet);
			}

            if(!this.options.password) {
                log.error(`you must specify --password=*** or use 'kaspa-wallet permanently-decrypt'`);
                process.exit(0);
            }
                
            let decrypted = await this.decryptMnemonic(this.options.password, walletMeta.wallet.mnemonic)
            .catch(e=>{
                reject(e);
            });
            let {privKey, seedPhrase} = decrypted||{};
            const { network, rpc } = this;
            let wallet = new Wallet(privKey, seedPhrase, { network, rpc });
            resolve(wallet);
		})
	}

	async decryptMnemonic(password, encryptedMnemonic){
		//console.log("decrypted", password, encryptedMnemonic)
		let decrypted = await Wallet.passwordHandler.decrypt(password, encryptedMnemonic);
		return JSON.parse(decrypted)
	}
	async encryptMnemonic(password, mnemonic){
		let encrypted = await Wallet.passwordHandler.encrypt(password, mnemonic);
		return encrypted
	}

	async main() {

		let dump = (label, text, deco1="-", deco2="=")=>{
			console.log(`\n${label}:\n${deco1.repeat(100)}\n${text}\n${deco2.repeat(100)}\n`)
		}

		const logLevels = ['error','warn','info','verbose','debug'];
		program
			.version(pkg.version, '--version')
			.description(`Kaspa Wallet CLI v${pkg.version}`)
			.helpOption('--help','display help for command')
			.option('--no-sync','disable network sync for all operations')
			.option('--log <level>',`set log level ${logLevels.join(', ')}`, (level)=>{
				if(!logLevels.includes(level))
					throw new Error(`Log level must be one of: ${logLevels.join(', ')}`);
				return level;
			})
			.option('--verbose','log wallet activity')
			.option('--debug','debug wallet activity')
			.option('--testnet','use testnet network')
			.option('--devnet','use devnet network')
			.option('--simnet','use simnet network')
			.option('--grpc-server <address>','use custom RPC address <host:port>')
			// .option('--folder <path>','use custom folder for wallet file storage') // TODO
			// .option('--file <filename>','use custom wallet filename') // TODO
			.option('--password <password>','unlock wallet with password')
            .option('--nats-server <host>:<port>','use custom NATS server')
            .option('--token <host>:<port>','use token for NATS server auth')
            ;




        program
	        .command('proxy', { isDefault : true })
	        .description('proxy NATS with Kaspa Wallet and Kaspad gRPC')
//	        .option('--password <password>','amount of each transaction')
	        // .option('--amount <amount>','amount of each transaction')
	        // .option('--count <count>','number of transactions')
	        .action(async (count, amount, options) => {



                const natsOptions = {
                    servers : this.options.nats || 'nats.kaspanet.io'
                }

                if(this.options.token)
                    natsOptions.token = this.options.token;
                // let servers = options.nats || 'nats.kaspanet.io';
                // let token = options.token || undefined;

                try {
                    await this.connectNATS(natsOptions);
                } catch(error) {
                    log.error(`unable to connect to "${natsOptions.server}"`);
                    log.error(error.toString());
                    log.error(error);
                    process.exit(0);
                }

                log.info('open Wallet...');
                this.wallet = await this.openWallet();

                log.info('init NATS...');
                await this.proxyGRPCToNATS();
                await this.proxyWalletToNATS();

                this.sim = new KaspaSim(__dirname, this);
                await this.sim.init();

                log.info('network Sync...');
                await this.networkSync();
                this.setupLogs(wallet);
                await this.wallet.sync(true);
            });

            program.parse(process.argv);

	}

    
    getProto() {
        const rpc = new RPC({ clientConfig:{disableConnectionCheck : true } });
        rpc.disconnect();
        return rpc.client.proto;
    }

    async proxyGRPCToNATS() {

        const proto = this.getProto();
        const methods = proto.KaspadMessage.type.field
            .filter(({name})=>/request/i.test(name));

        methods.forEach(method=>{
            const {name, typeName} = method;
            const fn = name.replace(/Request$/,'');
            let fields = proto[typeName].type.field;
            // log.verbose(`proxying ${name} to NATS`);
            let subscription = this.nats.subscribe(name);
            (async()=>{
                for await(const msg of subscription) {
                    try {

                        const args = msg.data ? jc.decode(msg.data) : { };
                        this.rpc.request(name, args)
                        .then((result)=>{
                            console.log(JSON.stringify(result,null,'    '));

                            if(msg.reply)
                                msg.respond(jc.encode(result));
                        })
                        .catch(error=>{
                            console.log("Error:", error.toString())
                            if(msg.reply)
                                msg.respond(jc.encode(result));
                        })

                    } catch(error) {
                        this.nats.publish('KASPA.error', jc.encode({ error }));
                        if(msg.reply) {
                            msg.respond(jc.encode({error}));
                        }
                    }
                }
            })().then();
        })
    }

    async proxyWalletToNATS() {

        const { uid, wallet } = this;

        wallet.on("utxo-change", (detail)=>{
            detail.added.forEach((entries, address)=>{
                entries.forEach(entry=>{
                    this.nats.publish('KASPA.utxo.change', jc.encode({uid, action:'added', address, ...entry}));
                })
            })

            detail.removed.forEach((entries, address)=>{
                entries.forEach(entry=>{
                    this.nats.publish('KASPA.utxo.change', jc.encode({uid, action:'removed', address, ...entry}));
                })
            })
        });


        (async()=>{
            const sub_balance = this.nats.subscribe('KASPA.wallet.balance');
            for await(const msg of sub_balance) {
                if(!msg.reply)
                    return;

                msg.respond(jc.encode(this.wallet.balance));
            }
        })().then();


        (async()=>{

            const sub_send = this.nats.subscribe('KASPA.wallet.send');

            for await(const msg of sub_send) {
                if(!msg.reply)
                    return;

                if(!msg.data)
                    return msg.respond(jc.encode({ error : `missing data in ${msg.subject}`}));

                const data = jc.decode(msg.data);
                const { address, amount, fee, networkFee } = data;

				try {
					amount = new Decimal(amount).mul(1e8).toNumber();
				} catch(ex) {
                    msg.respond(jc.encode({ error : `Error parsing amount: ${amount}`}));
                    console.log(ex);
					return;
				}
				if(fee) {
					try {
						fee = new Decimal(fee).mul(1e8).toNumber();
					} catch(ex) {
                        msg.respond(jc.encode({ error : `Error parsing fee: ${fee}`}));
                        console.log(ex);
						return;
					}
				}

				try {
					try {
						let response = await this.wallet.submitTransaction({
							toAddr: address,
							amount,
							fee,
							calculateNetworkFee : networkFee
						}, true);

                        msg.respond(jc.encode(response));
					} catch(ex) {
						//console.log(ex);
						log.error(ex.toString());
					}

					this.rpc.disconnect();
				} catch(ex) {
					log.error(ex.toString());
				}

            }

        })().then();


        const sub_info = this.nats.subscribe('KASPA.wallet.info');
        (async()=>{
            for await(const msg of sub_info) {
                if(!msg.reply)
                    return;
                if(!this.wallet)
                    return msg.respond({ error : `no open wallet`});

                const { wallet } = this;

                const resp = {
                    network : wallet.network,
                    blueScore : wallet.blueScore,
                    receiveAddress : wallet.addressManager.receiveAddress.current.address,
                    balance : wallet.balance,
                    receiveAddressUsed : wallet.addressManager.receiveAddress.counter,
                    changeAddressUsed : wallet.addressManager.changeAddress.counter
                }

                msg.respond(jc.encode(resp));
            }
        })().then();
    
    

        const sub_transactions = this.nats.subscribe('KASPA.wallet.tx.list');
        (async()=>{
            for await(const msg of sub_transactions) {
                if(!msg.reply)
                    return;
                if(!this.wallet)
                    return msg.respond({ error : `no open wallet`});
                // msg.respond(jc.encode({ receiveAddress : wallet.receiveAddress }));
                msg.respond(jc.encode({ok:true}));

                Object.entries(wallet.utxoSet.utxoStorage).forEach(([address, UTXOs])=>{
                    //console.log(`${address}:`);
                    UTXOs.sort((a,b) => { return a.blockBlueScore - b.blockBlueScore; });
                    // let width = 0;
                    // UTXOs.forEach((utxo) => {
                    //     let kas = `${this.KAS(utxo.amount)}`;
                    //     if(kas.length > width)
                    //         width = kas.length;
                    // })
                    UTXOs.forEach((utxo) => {
                        this.nats.publish('KASPA.wallet.tx.data', jc.encode(utxo));
                        // console.log(` +${this.KAS(utxo.amount, width+1)}`,`KAS`,`txid:`, `${utxo.transactionId} #${utxo.index}`.green,'Blue Score:', utxo.blockBlueScore.cyan);
                    })
                })
            }
        })().then();
   

        const sub_address = this.nats.subscribe('KASPA.wallet.address');
        (async()=>{
            for await(const msg of sub_address) {
                if(!msg.reply)
                    return;
                if(!this.wallet)
                    return msg.respond({ error : `no open wallet`});
                msg.respond(jc.encode({ receiveAddress : wallet.receiveAddress }));
            }
        })().then();
    
        const sub_compound = this.nats.subscribe('KASPA.wallet.compound');
        (async()=>{
            for await(const msg of sub_compound) {
                if(!msg.reply)
                    return;

                if(!this.wallet)
                    return msg.respond({ error : `no open wallet`});

                // TODO: THIS WILL TAKE TOO LONG - NATS WILL TIMEOUT!
                let response = await wallet.compoundUTXOs();
                msg.respond(jc.encode(response));

            }
        })().then();


        const sub_list_sim_txs = this.nats.subscribe('KASPA.sim.txs.list');
        (async()=>{
            for await(const msg of sub_list_sim_txs) {
                if(!msg.reply)
                    return;
                try {
                    const data = msg.data ? jc.decode(msg.data) : {};
                    const ident = data.ident || 'default';
                    let {txs} = this.sim.getTestTransactions(ident);
                    msg.respond(jc.encode({tx_count : txs.length}));
                } catch(error) {
                    log.error(error.toString());
                    msg.respond(jc.encode({error}));
                }
                // for(const tx of txs)
                //     this.nats.publish()
            }
        })().then();

        const sub_post_sim_txs = this.nats.subscribe('KASPA.sim.txs.post');
        (async()=>{
            for await(const msg of sub_post_sim_txs) {
                if(!msg.reply)
                    return;
                try {
                    const data = msg.data ? jc.decode(msg.data) : {};
                    const ident = data.ident || 'default';
                    msg.respond(jc.encode({ok:true}));
					// wallet.setLogLevel('none');
					this.sim.postTestTransactions(ident, {wallet});
                } catch(error) {
                    log.error(error.toString());
                    msg.respond(jc.encode({error}));
                }
                // for(const tx of txs)
                //     this.nats.publish()
            }
        })().then();

        const sub_create_sim_txs = this.nats.subscribe('KASPA.sim.txs.create');
        (async()=>{
            for await(const msg of sub_create_sim_txs) {
                if(!msg.reply)
                    return;
                try {
                    const data = msg.data ? jc.decode(msg.data) : {};
                    const ident = data.ident || 'default';

                    let { amount, count } = data;
                    amount = parseFloat(amount);
                    count = parseInt(count);
                    if(!amount) 
                        return msg.respond(jc.encode({error:`invalid amount ${amount}`}));
                    if(!count) 
                        return msg.respond(jc.encode({error:`invalid count ${count}`}));

                    msg.respond(jc.encode({ok:true}));
					// wallet.setLogLevel('none');
					this.sim.createTestTransactions(ident, {wallet});

					let address = data.address || wallet.addressManager.receiveAddress.atIndex[0];
					return this.createTestTransactions({
						wallet, address, amount, count
					})

                } catch(error) {
                    log.error(error.toString());
                    msg.respond(jc.encode({error}));
                }
                // for(const tx of txs)
                //     this.nats.publish()
            }
        })().then();

    }

	rpcDisconnect(){
		dpc(1000, ()=>{
			this.rpc.disconnect()
		})
	}


	getDuration(ts) {
		if(!ts)
			return '--:--:--';
		let delta = Math.round(ts / 1000);
		let sec_ = (delta % 60);
		let min_ = Math.floor(delta / 60 % 60);
		let hrs_ = Math.floor(delta / 60 / 60 % 24);
		let days = Math.floor(delta / 60 / 60 / 24);

		let sec = (sec_<10?'0':'')+sec_;
		let min = (min_<10?'0':'')+min_;
		let hrs = (hrs_<10?'0':'')+hrs_;

		if(days && days >= 1) {
			return `${days.toFixed(0)} day${days>1?'s':''} ${hrs}h ${min}m ${sec}s`;
		} else {
			let t = '';
			if(hrs_)
				t += hrs+'h ';
			if(hrs_ || min_) {
				t += min+'m ';
				t += sec+'s ';
			}
			else {
				t += sec_.toFixed(1)+' seconds';
			}
			return t;
		}
	}

	networkSync(){

		if(this.options.sync === false)
			return Promise.resolve();

		return new Promise(async (resolve, reject)=>{

			this.isNetworkSync = true;
			this.syncState = 'connect';
			const nsTs0 = Date.now();
			const barsize = (process.stdout.columns || 120) - 66;
			const hideCursor = true;
			const clearOnComplete = true;

			const headerSpan = 5000;

			try {
				await this.rpc.connect();
			} catch(ex) {
				log.error(ex.toString());
				process.exit(1);
			}

			this.syncState = 'init';
			log.info(`sync ... starting network sync`);

			let progress = null;

			const syncWait = () => {
				if(progress)
					progress.stop();
				progress = new Task(this, 'DAG sync - waiting',{
					format: '[{bar}] Headers: {headerCount} Blocks: {blockCount} Elapsed: {duration_formatted}',
					hideCursor, clearOnComplete, barsize
				});
				progress.start(headerSpan, 0, { headerCount : '...', blockCount: '...' });
			}

			const syncHeaders = () => {
				if(progress)
					progress.stop();
				progress = new Task(this, 'DAG sync - headers',{
					format: '[{bar}] Headers: {headerCount} - elapsed: {duration_formatted}',
					hideCursor, clearOnComplete, barsize
				});
				progress.start(headerSpan, 0);
			}

			const syncBlocks = () => {
				if(progress)
					progress.stop();
				progress = new Task(this, 'DAG sync - blocks',{
					format: '[{bar}] {percentage}% | ETA: {eta}s - elapsed: {duration_formatted}',
					hideCursor, clearOnComplete, barsize
				});
				progress.start(100, 0);
			}

			const medianOffset = (30+45)*1000; // allow 45 sec behind median
//			const medianOffset = 45*1000; // allow 45 sec behind median
			const medianShift = Math.ceil(263*0.5*1000+medianOffset);
			let firstBlockCount;
			let firstHeaderCount;
			let firstMedianTime;

			let ready = false;
			while(!ready){
				let bdi = await this.rpc.client.call('getBlockDagInfoRequest').catch((ex)=>{
					console.log('');
					log.error(ex.toString());
					log.error('giving up...');
					process.exit(1);
				});

				if(this.resetNetworkSync) {
					this.resetNetworkSync = false;
					if(progress)
						progress.stop();
					progress = null;
					this.syncState = 'init';
				}

				//let vspbs = await this.rpc.client.call('getVirtualSelectedParentBlueScoreRequest');
				const pastMedianTime = parseInt(bdi.pastMedianTime);// + (75*1000);
				const blockCount = parseInt(bdi.blockCount);
				const headerCount = parseInt(bdi.headerCount);
				//const { blueScore } = parseInt(vspbs.blueScore);


				switch(this.syncState) {
					case 'init': {
						firstBlockCount = blockCount;
						firstHeaderCount = headerCount;
						syncWait();
						this.syncState = 'wait';
					} break;

					case 'wait': {
						if(firstBlockCount != blockCount) {
							this.syncState = 'blocks';
							syncBlocks();
							firstMedianTime = pastMedianTime;
							continue;
						}
						else
						if(firstHeaderCount != headerCount) {
							this.syncState = 'headers';
							syncHeaders();
							continue;
						}
						else {
							progress.update(0, { blockCount, headerCount });
						}
					} break;

					case 'headers': {
						progress.update(headerCount % headerSpan, { headerCount, blockCount });
						if(firstBlockCount != blockCount) {
							this.syncState = 'blocks';
							syncBlocks();
							firstMedianTime = pastMedianTime;
							continue;
						}

					} break;

					case 'blocks': {
						const ts = (new Date()).getTime();
						const total = ts - firstMedianTime - medianShift;
						const range = pastMedianTime - firstMedianTime;
						let delta = range / total;
						// console.log({shift:ts-pastMedianTime,delta,ts,total:total/1000,range:range/1000,pastMedianTime,firstMedianTime,diff:(ts-pastMedianTime-medianShift)/1000,firstVsLast:(pastMedianTime-firstMedianTime)/1000});
						if(pastMedianTime+medianShift >= ts) { //} || delta > 0.999) {
							progress.update(100, { headerCount, blockCount });
							await delay(256);
							progress.stop();
							ready = true;
							// console.log("...network ");
							continue;
						}

						const percentage = delta*100;
						progress.update(Math.round(percentage), { headerCount, blockCount });

					} break;
				}

				await delay(1000);
			}

			const nsDelta = Date.now()-nsTs0;
			log.info(`sync ... finished (network sync done in ${this.getDuration(nsDelta)})`);
			this.isNetworkSync = false;
			resolve();
		})
	}

    
	async connectNATS(options) {
		this.nats = await NATS.connect(options);
		(async () => {
			log.info(`NATS connected to ${this.nats.getServer()}`);
			for await (const status of this.nats.status()) {
				//console.info(`NATS: ${status.type}: ${status.data}`);
			}
		})().then();

		this.nats.closed().then((err) => {
			console.log(`connection closed ${err ? " with error: " + err.message : ""}`);
		});

		const { info } = this.nats.protocol;
		const entries = Object.entries(info);
		let padding = entries.map(([k]) => k.length).reduce((a,k) => Math.max(k,a));
		entries.forEach(([k,v]) => {
			log.verbose(`${k}:`.padStart(padding+1,' '),(v+''));
		})
	}

	async stopNATS() {
        if(this.nats) {
            await this.nats.drain();
            this.nats.close();
            delete this.nats;
        }
	}

}



(async()=>{
	g_daemon = new KaspaNATS();
	await g_daemon.init();
	await g_daemon.main();
})();
