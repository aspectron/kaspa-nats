const cliProgress = require('cli-progress');
const NATS = require('nats');
const jc = NATS.JSONCodec();

class Task {
    constructor(core, name, options) {
        this.name = name;
        this.uid = core.uid;
        this.nats = core.nats;
        const { hideCursor, clearOnComplete, barsize, format, ident } = options;
        this.ident = ident;
        this.progress = new cliProgress.SingleBar({
            hideCursor, clearOnComplete, barsize,
            format : `${name} ${format}`
        }, cliProgress.Presets.rect);
    }

    start(total, current, data) {
        if(this.running)
            this.stop();
        this.running = true;
//        g_currentTask = this;
        this.data = data;
        this.total = total;
        this.current = this.current || 0;
        this.percent = (this.current / this.total)*100.0;

        this.interval = setInterval(()=>{
            this.post();
        }, 1000);

        this.progress.start(total, current, data);
    }

    stop() {
        clearInterval(this.interval);
        this.interval = null;
//        g_currentTask = null;
        this.progress.stop();
        this.progress = null;
        this.running = false;
    }

    update(current, data) {
        this.data = data;
        this.current = current;
        this.percent = (this.current / this.total)*100.0;
        this.progress.update(current, data);
    }

    getString() {
        return JSON.stringify({ name : this.name, percent : this.percent, ...this.data });
    }

    post() {
        //console.log(this.getString());
        const { uid } = this;
        const { percent, current, total, ident } = this;
        this.nats.publish('KASPA.task.update', jc.encode({ uid, percent, current, total, ident, ...this.data}))
    }
}

module.exports = Task;