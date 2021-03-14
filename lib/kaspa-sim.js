const { FlowLogger } = require('@kaspa/wallet');
const cliProgress = require('cli-progress');
const fs = require('fs');
const path = require('path');
const os = require('os');
const mkdirp = require("mkdirp");
const log = new FlowLogger('Sim', {
	display : ['level','time','name'],
	color: ['level', 'content']
});

class KaspaSim {

    constructor(appFolder, core) {
        this.core = core;
        this.uid = core.uid;
        this.nats = core.nats;
        this.appFolder = appFolder;
        this.dataFolder = path.join(appFolder,'data');
        if(!fs.existsSync(this.dataFolder))
            mkdirp.sync(this.dataFolder);
//		this.testTxsFilePath = path.join(this.dataFolder, "transactions.json");
    }

    async init() {
        return;
    }

    getTxsFilePath(ident) {
        return path.join(this.dataFolder,`${ident}.json`);
    }

	getTestTransactions(ident){
		let utxoIds = [], transactions=[];
		const txFilePath = this.testTxsFilePath;
		if(fs.existsSync(txFilePath)){
			let info = fs.readFileSync(txFilePath)+"";
			let {transactions:list} = JSON.parse(info);
			list.map(tx=>{
				utxoIds.push(...tx.utxoIds)
			})
			transactions = list;
			log.info(`Tx file loaded: ${transactions.length} txs, ${utxoIds.length} utxos`)
		}

		return {transactions, utxoIds};
	}

	saveTestTransactions(ident, transactions){
		fs.writeFileSync(this.getTxsFilePath(ident), JSON.stringify({transactions}, null, "\t"));
	}

	postTestTransactions(ident, {wallet, postType='chunk-n-direct', chunkSize=50}, CB){
		const barsize = 50;//(process.stdout.columns || 120) - 100;
		const hideCursor = false;
		const clearOnComplete = false;
		const progress = new Task(this.core, 'PostTXs',{
			format: `[{bar}] `+
					`ETA: {eta}s | {value} / {total} | Eld: {duration_formatted} | `+
					`{status}`,
			hideCursor, clearOnComplete, barsize
		});
		let progressStoped = true;
		const stopProgress = ()=>{
			progressStoped = true;
			progress.stop()
		}
		const startProgress = (total, start, opt)=>{
			if(progressStoped){
				progressStoped = false;
				progress.start(total, start, opt)
			}
			else
				progress.update(start, opt)
		}

		let {txs:signedTxs}= this.getTestTransactions();

		let ts = Date.now();
		let totalTxs = signedTxs.length
		log.info(`Sending ${totalTxs} transactions ....`)
		let result = [];
		let errors = [];
		let errors2 = [];
		let txWithErrors = [];
		let finished = 0;

		startProgress(totalTxs, 0, {status:''});

		const onTxError = (err)=>{
			let m = err.message;
			errors.push(m)
			if(!m.includes("already spent") && !m.includes("fully-spent transaction")){
				txWithErrors.push(tx);
				errors2.push(m);
			}
		}

		const submitTx = (tx, next)=>{
			return wallet.api.submitTransaction(tx.rpcTX)
			.then(txid=>{
				finished++;
				progress.update(finished)
				result.push(txid)
				next?.();
			})
			.catch(err=>{
				finished++;
				progress.update(finished)
				onTxError(err)
				next?.();
			})
		}

		const postDirect = (txs)=>{
			let length = txs.length, count=0;
			return new Promise((resolve)=>{
				txs.map(tx=>{
					submitTx(tx, ()=>{
						if(++count >= length)
							resolve();
					})
				})
			})
		}

		const postDelayed = (txs)=>{
			let tx;
			return new Promise(async(resolve)=>{
				tx = txs.shift();
				while(tx){
					await submitTx(tx)
					tx = txs.shift();
					await delay(256);
				}

				resolve();
			})
		}

		const showResult = ()=>{
			if(result.length + errors.length < totalTxs)
				return
			log.info(`Finished in ${((Date.now()-ts)/1000).toFixed(2)}sec.`)
			log.info(`Posted: ${result.length}`)
			log.info(`Errors: ${errors2.length}`, errors2)
			log.info(`ALL Errors: ${errors.length}`, errors)
			
			signedTxs = txWithErrors;
			this.saveTestTransactions(ident, signedTxs);
			this.rpcDisconnect();
			CB?.();
		}


		switch(postType){
			case 'chunk-n-direct':
				let chunks = [];
				while(signedTxs.length)
					chunks.push(...signedTxs.splice(0, chunkSize))

				let method = postDelayed;
				const post = ()=>{
					method = method == postDelayed?  postDirect : postDelayed
					let chunk = chunks.shift();
					console.log("chunk", chunk.length)
					if(chunk && chunk.length){
						method(chunk).then(()=>{
							dpc(post)
						});
					}else{
						showResult()
					}
				}

				post();
			break;
			default:
			case 'default':
				log.info("Posting all in series");
				postDirect(signedTxs).then(showResult);
			break;
		}

		
	}

	createTestTransactions(ident, {wallet, address, count, amount, send}){
		/*
		if(wallet._isOurChangeOverride){
			wallet._isOurChangeOverride = true;
			const changeAddrOverride = wallet.addressManager.changeAddress.atIndex[0];
			const isOurChange = wallet.addressManager.isOurChange.bind(wallet.addressManager)
			wallet.addressManager.isOurChange = (address)=>{
				if(address == changeAddrOverride)
					return false;
				return isOurChange(address);
			}
		}
		*/
		
		let signedTxs = [];

		const {utxoIds, txs} = this.getTestTransactions();
		wallet.utxoSet.inUse.push(...utxoIds);
		signedTxs.push(...txs)

		if(signedTxs.length > count){
			log.info(`Number of stored transactions ${signedTxs.length} is larger than ${count}`)
			return this.rpcDisconnect();
		}

		log.info(`Creating ${count-signedTxs.length} (${count} - ${signedTxs.length}) transactions with ${amount}KAS each.`)

		amount = Number(amount) * 1e8;
		const flushTxsToFile = ()=>{
			this.saveTestTransactions(ident,signedTxs);
		}

		const submitTxResult = [];

		const barsize = 50;//(process.stdout.columns || 120) - 100;
		const hideCursor = false;
		const clearOnComplete = false;
		const progress = new Task(this.core, 'CreatingTXs', {
            ident : 'create-txs',
			format: `[{bar}] `+
					`ETA: {eta}s | {value} / {total} | Eld: {duration_formatted} | `+
					`{status}`,
			hideCursor, clearOnComplete, barsize
		});

		let progressStoped = true;
		const stopProgress = ()=>{
			progressStoped = true;
			progress.stop()
		}
		const startProgress = (total, start, opt)=>{
			if(progressStoped){
				progressStoped = false;
				progress.start(total, start, opt)
			}
			else
				progress.update(start, opt)
		}
		

		startProgress(count, 0, {status:''});



		let submitTxMap = new Map();
		let utxoId2TXIdMap = new Map();
		const submitTx = async (rpcTX, id)=>{
			let error=false;
			submitTxMap.set(id, rpcTX.transaction.outputs.length-1);
			let txid = await wallet.api.submitTransaction(rpcTX)
			.catch(err=>{
				error = err.error || err.message
				_log("\nerror", err)
			})
			if(error){
				submitTxMap.delete(id);
			}else{
				rpcTX.transaction.outputs.map((o, index)=>{
					let txoId = txid+index;
					utxoId2TXIdMap.set(txoId, id);
				})
			}
			submitTxResult.push({txid, error})
			progress.update(signedTxs.length, {status: txid? "txid:"+txid: error})
			submitTxMap.size && run()
		}

		let stoped = false;
		const done = ()=>{
			if(stoped)
				return
			stoped = true;
			stopProgress();
			//log.info('')
			//log.info("submitTxResult", submitTxResult)
			log.info("signedTxs", signedTxs.length)
			this.rpcDisconnect();
			//process.exit(0)
		}

		let running = 0;
		let status = '';
		const createTx = ()=>{
			if(stoped)
				return
			const nums = count-signedTxs.length;
			startProgress(count, signedTxs.length, {status});
			this._createTestTxs({
				wallet, address, count:nums, totalCount:count,
				amount,
				signedTxs, _log
			}, ({rpcTX, utxoIds, to, id})=>{
				
				if(to.length > 1){
					progress.update(signedTxs.length, {status: 'submiting TX'})
					submitTx(rpcTX, id);
				}else{
					signedTxs.push({rpcTX, id, utxoIds})
					debounce("flushTxsToFile", 200, flushTxsToFile);
					progress.increment();
					if(signedTxs.length >= count){
						done()
					}
				}
			});
			let outCount = 0;
			submitTxMap.forEach((count)=>{
				outCount += count;
			})
			status = "waitingTxs:"+submitTxMap.size+"("+outCount+") isRunning:"+running;
			let filled = signedTxs.length >= count
			if( !filled && running > 1)
				return createTx();
			running = 0;
			dpc(1, ()=>{
				let {utxos} = wallet.utxoSet.collectUtxos(Number.MAX_SAFE_INTEGER)
				let pendingUtxoCount = wallet.utxoSet.utxos.pending.size
				if(filled || (!submitTxMap.size && running<1 && !pendingUtxoCount && !utxos.length) ){
					_log("calling done.........")
					done();
				}else{
					//_log("utxos:"+utxos.length+", running:"+running)
					run();
				}
			})
		}

		const run = ()=>{
			if(running){
				running++;
				return
			}
			running = 1;
			createTx();
		}

		const _log = (...args)=>{
			if(stoped)
				return
			stopProgress();
			//log.info('');
			log.info(...args);
			startProgress(count, signedTxs.length, {status:''});
		}

		run();

		if(signedTxs.length < count){
			wallet.on("balance-update", ()=>{
				debounce("submitTxMapsize", 500, ()=>{
					if(submitTxMap.size){
						let before = submitTxMap.size;
						let txId, utxoID, utxos = wallet.utxoSet.utxos.confirmed;
						utxos.forEach(utxo=>{
							utxoID = utxo.txId + utxo.outputIndex;
							txId = utxoId2TXIdMap.get(utxoID)
							if(txId)
								submitTxMap.delete(txId);
						})
						_log("waitingTxs update", before+"=>"+submitTxMap.size)
					}

					run();
				})
				run();
			})
		}

	}
	/*
	BYTES : 2+8+151+8+43+8+20+8+8+32
	Txn Version: 2
	number of inputs: 8
	INPUT::::: 151
		previus tx ID:32
		index: 4
		length of signature script: 8
		SignatureScript length: 99
		sequence: 8

	number of outputs: 8
	OUTPUT:::: 43
		value: 8
		Version: 2
		length of script public key: 8
		ScriptPublicKey.Script: 25
	lock time: 8
	subnetworkId: 20
	gas:8
	length of the payload: 8
	Payload: 
	payload hash: 32

	*/

	_createTestTxs({wallet, _log, address, count, totalCount, amount, signedTxs, maxFee=6000}, CB){
		if(count<1)
			return
		const {kaspacore} = Wallet;
		const changeAddr = wallet.addressManager.changeAddress.atIndex[0];
		let {utxos, utxoIds} = wallet.utxoSet.collectUtxos(Number.MAX_SAFE_INTEGER)
		//utxos.map(u=>{
		//	u.m = Math.round(u.satoshis % amt);
		//})
		utxos = utxos.sort((a, b)=>{
			return a.satoshis-b.satoshis;
		})
		const baseFee = 94;
		const feePerOutput = 43;
		const feePerInput = 151;

		const createToFields = ({inputCount, totalAmount})=>{
			const inputFee = inputCount * feePerInput;
			let fee = baseFee+inputFee+feePerOutput // base + inputs + change output fee
			const oneOutputAmount = amount+feePerOutput;

			let to = [];
			let total = fee;
			do{
				to.push({address, amount})
				fee += feePerOutput;
				total += oneOutputAmount;
			}while(fee<maxFee && total < totalAmount-oneOutputAmount);

			if(to.length>1){//if there are more outputs send it to itself
				to.map(to=>{
					to.address = changeAddr
				})
			}
			return {to, fee};
		}

		const createTx = ({utxos, total})=>{
			
			const utxoIds = [];
			const privKeys = utxos.reduce((prev, cur) => {
				const utxoId = cur.txId + cur.outputIndex;
				utxoIds.push(utxoId);
				return [wallet.addressManager.all[String(cur.address)], ...prev];
			}, []);

			const {to, fee} = createToFields({inputCount:utxos.length, totalAmount:total})


			const tx = new kaspacore.Transaction()
				.from(utxos)
				.to(to)
				.setVersion(0)
				.fee(fee)
				.change(changeAddr)
			tx.sign(privKeys, kaspacore.crypto.Signature.SIGHASH_ALL, 'schnorr');

			const {nLockTime: lockTime, version, id } = tx;
			const inputs = tx.inputs.map(input => {
				//_log("input.script.toBuffer()", input.script.toBuffer().length)
				return {
					previousOutpoint: {
						transactionId: input.prevTxId.toString("hex"),
						index: input.outputIndex
					},
					signatureScript: input.script.toBuffer().toString("hex"),
					sequence: input.sequenceNumber
				};
			})
			const outputs = tx.outputs.map(output => {
				//_log("output.script.toBuffer()", output.script.toBuffer().length)
				return {
					amount: output.satoshis,
					scriptPublicKey: {
						scriptPublicKey: output.script.toBuffer().toString("hex"),
						version: 0
					}
				}
			})

			const rpcTX = {
				transaction: {
					version,
					inputs,
					outputs,
					lockTime,
					payloadHash: '0000000000000000000000000000000000000000000000000000000000000000',
					subnetworkId: wallet.subnetworkId,
					fee
				}
			}

			wallet.utxoSet.inUse.push(...utxoIds)

			//_log("createTx", utxos.length, fee, total, to.length)
			CB({rpcTX, utxoIds, id, to})
		}

		let satoshis = 0;
		let txUTXOs = [];
		let fee = baseFee;
		const amountPlusFee = amount+fee;
		let _amountPlusFee = amountPlusFee;
		//_log("___utxos__ :"+utxos.length)
		for (const u of utxos){
			satoshis += u.satoshis;
			txUTXOs.push(u);
			if(satoshis/_amountPlusFee >= 1){
				//_log("_amountPlusFee1111", txUTXOs.length, satoshis, amountPlusFee)
				createTx({utxos:txUTXOs, fee, total:satoshis})
				_amountPlusFee = amountPlusFee;
				fee = baseFee;
				satoshis = 0;
				txUTXOs = [];
			}else{
				_amountPlusFee += feePerInput;
				fee += feePerInput;
				//_log("_amountPlusFee", txUTXOs.length, satoshis, amountPlusFee)
			}
			if(signedTxs.length>=totalCount)
				break;
			//console.log("u.satoshis", u.n, u.satoshis)
		}
	}
}

module.exports = KaspaSim;
