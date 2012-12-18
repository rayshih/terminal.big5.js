var util = require('./util');
var ansi = require('./ansi');
var csi = require('./csi');
var character = require('./character');

var Iconv = require("iconv").Iconv;
var iconv = new Iconv("cp950", "UTF-8//IGNORE");

exports.TermDiff = require('./termdiff').TermDiff;

var escapeHandler = {}
escapeHandler[csi.chr] = csi.exec
escapeHandler[ansi.chr] = ansi.exec

var graphics = {
	'`': '\u25C6',
	'a': '\u2592',
	'b': '\u2409',
	'c': '\u240C',
	'd': '\u240D',
	'e': '\u240A',
	'f': '\u00B0',
	'g': '\u00B1',
	'h': '\u2424',
	'i': '\u240B',
	'j': '\u2518',
	'k': '\u2510',
	'l': '\u250C',
	'm': '\u2514',
	'n': '\u253C',
	'o': '\u23BA',
	'p': '\u23BB',
	'q': '\u2500',
	'r': '\u23BC',
	's': '\u23BD',
	't': '\u251C',
	'u': '\u2524',
	'v': '\u2534',
	'w': '\u252C',
	'x': '\u2502',
	'y': '\u2264',
	'z': '\u2265',
	'{': '\u03C0',
	'|': '\u2260',
	'}': '\u00A3',
	'~': '\u00B7',
};


function Terminal(width, height, attr) {
	this.scrollBack = [];
	this.width = width || 80;
	this.height = height || 24;
	this.leds = {1:false,2:false,3:false,4:false}
	this.lineAttr = {
		doubletop: false,
		doublebottom: false,
		doublewidth: false
	};
	this.defaultAttr = util.extend({
		fg: 15,
		bg: 0,
		bold: false,
		underline: false,
		blink: false,
		inverse: false,
	}, attr || {});
	this.reset();
}

Terminal.prototype = {
	createChar: function(code) {
		this.attrCommited = true;
		if(this.mode.graphic) {
			chr = code.toString();
			chr = graphics[chr] !== undefined ? graphics[chr] : chr;

			code = String.fromCharCode(chr);
		}
		return {
			code: code === undefined ? ' '.charCodeAt(0) : code,
			attr: this.attr,
		};
	},
	createLine: function() {
		return {line: [], attr: {}};
	},
	getLine: function() {
		var c = this.cursor;
		return this.buffer[c.y] || (this.buffer[c.y] = this.createLine());
	},
	write: function(data) {
		// if there's an unfinished escape sequence
		if(this.escapeBuffer !== null) {
			data = Buffer.concat([this.escapeBuffer, data]);
			this.escapeBuffer = null
		}
		for(var i = 0; i < data.length && i >= 0; i++) {
			if(data[i] === '\x1b'.charCodeAt(0)) { // ESCAPE
				var len = this.escapeWrite(data.slice(i));
				if(len == 0)
					return true;
				i += len - 1;
			}
			else {
				character.exec(this, data[i]);
			}
		}
		return true;
	},
	escapeWrite: function(data) {
		var cmd = data[1];
		var handler = (escapeHandler[String.fromCharCode(data[1])] || escapeHandler[""]);
		var len = 0;
		if(cmd === undefined || (len = handler(this, data.toString())) == 0)
			this.escapeBuffer = data;
		return len;
	},
	inject: function(buf) {
		if(this.mode.insert)
			this.insertBlanks(buf.length);
		var line = this.getLine();
		line.changed = true;
		var c = this.cursor;
		for(var i = 0; i < buf.length; i++) {
			if(c.x >= this.width) {
				if(this.mode.wrap) {
					this.lineFeed();
					this.setCur({x:0});
					line = this.getLine();
					line.soft = true;
					line.changed = true;
				}
				else {
					this.setCur({x:this.width-1})
				}
			}
			line.line[c.x] = this.createChar(buf[i]);
			this.mvCur(1,0);
		}
	},
	lineFeed: function() {
		if(!this.mvCur(0,1))
			this.insertLines(1, this.cursor.y + 1);
		if(this.mode.crlf)
			this.setCur({x:0});
	},
	mvCur: function(x, y) {
		return this.setCur({
			x: this.cursor.x + parseInt(x),
			y: this.cursor.y + parseInt(y)
		});
	},
	setCur: function(cur) {
		var inbound = 0;
		if(cur.x < 0)
			cur.x = 0;
		else if(cur.x > this.width)
			cur.x = this.width;
		else
			inbound++;

		if(cur.y < 0)
			cur.y = 0;
		else if(cur.y >= this.height)
			cur.y = this.height - 1;
		else
			inbound++;

		if(cur.x !== undefined)
			this.cursor.x = cur.x;
		if(cur.y !== undefined)
			this.cursor.y = cur.y;

		return inbound === 2;
	},
	mvTab: function(n) {
		var nx = this.cursor.x;
		var tabMax = this.tabs[this.tabs.length - 1] || 0;
		var positive = n > 0;
		n = Math.abs(n);
		while(n != 0 && nx > 0 && nx < this.width-1) {
			nx += positive ? 1 : -1;
			if(util.indexOf(this.tabs, nx) != -1 || (nx > tabMax && nx % 8 == 0))
				n--;
		}
		this.setCur({x: nx});
	},
	tabSet: function() {
		this.tabs.push(this.cursor.x);
		this.tabs.sort();
	},
	tabClear: function(n) {
		switch(n || 'current') {
		case 'current':
		case 0:
			for(var i = this.tabs.length - 1; i >= 0; i--) {
				if(this.tabs[i] < this.cursor.x) {
					this.tabs.splice(i, 1);
					break;
				}
			}
			break;
		case 'all':
		case 3:
			this.tabs = [];
			break;
		}
	},
	saveCursor: function() {
		this.savedCursor.x = this.cursor.x;
		this.savedCursor.y = this.cursor.y;
	},
	restoreCursor: function() {
		this.setCur(this.savedCursor);
	},
	deleteCharacter: function(n) {
		var line = this.getLine().line;
		line.splice(this.cursor.x, n || 1);
	},
	setScrollRegion: function(n, m) {
		this.scrollRegion[0] = n;
		this.scrollRegion[1] = m;
	},
	eraseInDisplay: function(n) {
		switch(n || 'toEnd') {
		case 'toEnd':
		case '0':
			this.buffer.splice(this.cursor.y);
			break;
		case 'toBegin':
		case '1':
			var args = [0, this.cursor.y-1, Array(this.cursor.y-1)];
			Array.prototype.splice.apply(this.buffer, args);
			break;
		case 'entire':
		case '2':
			this.buffer.splice(0);
			return;
		}
		return this.eraseInLine(n);
	},
	eraseInLine: function(n) {
		var line = this.getLine();
		line.changed = true;
		switch(n || 'toEnd') {
		case '0':
		case 'toEnd':
			line.line.splice(this.cursor.x);
			break;
		case '1':
		case 'toBegin':
			var args = new Array(this.cursor.x+1);
			args.unshift(0, this.cursor.x+1);
			Array.prototype.splice.apply(line.line, args);
			while(line.line[line.line.length - 1] !== undefined)
				line.line.pop();
			break;
		case '2':
		case 'entire':
			line.line.splice(0);
			break;
		}
		return this;
	},
	deleteLine: function(n) {
		this.buffer.splice(this.cursor.y, n || 1);
	},
	resetAttr: function() {
		if(arguments.length === 0) {
			this.attr = this.defaultAttr;
			this.attrCommited = true;
		}
		for(var i = 0; i < arguments.length; i++)
			this.chAttr(arguments[i], this.defaultAttr[arguments[i]]);
	},
	chAttr: function(name, value) {
		if(this.attrCommited == true) {
			this.attr = util.extend({}, this.attr);
			delete this.attr.str
		}
		this.attr[name] = value;
		this.attrCommited = false;
	},
	reset: function() {
		this.defaultBuffer = [];
		this.altBuffer = [];
		this.buffer = this.defaultBuffer;
		this.mode = {
			cursor: true,
			appKeypad: false,
			wrap: true,
			insert: false,
			crlf: false,
			mousebtn: false,
			mousemtn: false,
			reverse: false,
			graphic: false
		}
		this.attr = this.defaultAttr;
		this.attrCommited = true;
		this.cursor = {x:0,y:0};
		this.savedCursor = {x:0,y:0};
		this.tabs = [];
		this.scrollRegion = [0, this.height];
		this.escapeBuffer = null;
	},
	insertBlanks: function(n) {
		var line = this.getLine();
		line.changed = true;
		var args = Array(parseInt(n));
		args.unshift(this.cursor.x,0);
		Array.prototype.splice.apply(line.line, args);
		line.line.splice(this.width);
	},
	insertLines: function(n, pos) {
		if(pos === undefined)
			pos = this.cursor.y;
		if(pos < this.scrollRegion[0] || pos > this.scrollRegion[1])
			return;
		var maxSize = this.scrollRegion[1] - this.scrollRegion[0];
		var scrollArea = this.buffer.splice(this.scrollRegion[0], maxSize);
		var args = Array(n);
		args.unshift(pos - this.scrollRegion[0], 0);
		Array.prototype.splice.apply(scrollArea, args);
		scrollArea.splice(0, scrollArea.length - maxSize);
	
		Array.prototype.push.apply(this.buffer, Array(Math.max(0, this.scrollRegion[0] - this.buffer.length)))
		args = scrollArea;
		args.unshift(pos, 0);
		Array.prototype.splice.apply(this.buffer, args);
	},
	toString: function(locateCursor) {
		var spaceCode = ' '.charCodeAt(0);
		var ret = []
		if(locateCursor) {
			var line = [];
			for(var i = 0; i < this.cursor.x + 3; i++) {
				line.push(spaceCode);
			}
			line.push('v'.charCodeAt(0));
			ret.push(line);
		}

		for(var i = 0; i < this.buffer.length; i++) {
			var line = []
			if(locateCursor) {
				line.push((this.buffer[i] && this.buffer[i].changed) ? "*".charCodeAt(0) : spaceCode);
				line.push(i == this.cursor.y ? ">".charCodeAt(0) : spaceCode);
			}
			if(this.buffer[i]) {
				for(var j = 0; j < this.buffer[i].line.length; j++) {
					var code = this.buffer[i].line[j] ? (this.buffer[i].line[j].code || spaceCode) : spaceCode;
					line.push(code);
				}
			}

			while(line[line.length-1] === spaceCode) {
				line.pop();
			}

			ret.push(line);
		}

		if(locateCursor) {
			var line = [];
			for(var i = 0; i < this.cursor.x+3; i++) {
				line.push(spaceCode);
			}
			line.push('^'.codeCharAt(0));
			ret.push(line);
		}

		var array = [];
		for (var i = 0; i < ret.length; i++) {
			var line = ret[i];
			for (var j = 0; j < line.length; j++) {
				array.push(line[j]);
			}
			array.push("\n".charCodeAt(0));
		}

		var buffer = new Buffer(array);
		convertedRet = iconv.convert(buffer).toString();
		return convertedRet;
	},
	setLed: function(n) {
		if(n == 0)
			for(var k in this.leds)
				this.leds[k] = false;
		else
			this.leds[n] = true;
		//this.metachanged();
		return this;
	},
	scroll: function(dir) {
		this.buffer.splice(this.scrollRegion[dir === 'up' ? 0 : 1], 0, this.createLine());
		if(this.height >= this.scrollRegion[dir === 'up' ? 1 : 0])
			this.buffer.splice(this.scrollRegion[dir === 'up' ? 1 : 0], 1);
	},
	eventToKey: function(event) {
		var kpd = this.mode.appKeypad;
		switch(event.which) {
			case 38: // up
				return kpd ? "\x1bOA" : "\x1b[A";
			case 40: // down
				return kpd ? "\x1bOB" : "\x1b[B";
			case 39: // right
				return kpd ? "\x1bOC" : "\x1b[C";
			case 37: // left
				return kpd ? "\x1bOD" : "\x1b[D";
			case 8:
				return "\x08";
			case 9:
				return "\t";
			default:
				return String.fromCharCode(event.which);
		}
	}
}

exports.Terminal = Terminal;
