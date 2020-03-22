/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { MumpsRuntime, MumpsBreakpoint } from './mumpsRuntime';
const { Subject } = require('await-notify');


/**
 * This interface describes the mumps-debug specific launch attributes
 * The schema for these attributes lives in the package.json of the mumps-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** The Port on which MDEBUG listens */
	port: number;
	/**The Hostname of the MDEBUG-Server */
	hostname: string;
	/**Map Local-Routines to Host-Routines */
	localRoutinesPath: string;

}
interface varData {
	name: string,
	indexCount: number,
	bases: Array<string>,
	content: string
}
export class MumpsDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	private _runtime: MumpsRuntime;

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("mumps-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new MumpsRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', MumpsDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', MumpsDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', MumpsDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', MumpsDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', MumpsDebugSession.THREAD_ID));
		});
		this._runtime.on('breakpointValidated', (bp: MumpsBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = false;

		// make VS Code to support data breakpoints
		response.body.supportsDataBreakpoints = false;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = false;
		response.body.completionTriggerCharacters = [".", "["];

		// make VS Code to send cancelRequests
		response.body.supportsCancelRequest = false;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;


		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished

		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		this._runtime.init(args.hostname, args.port, args.localRoutinesPath).then(async () => {
			this._runtime.start(args.program, !!args.stopOnEntry);
			this.sendResponse(response);
		}).catch((error) => {
			console.log(error);
		})
	}
	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		const path = <string>args.source.path;
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints = clientLines.map(l => {
			let { verified, line, id } = this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
			const bp = <DebugProtocol.Breakpoint>new Breakpoint(verified, this.convertDebuggerLineToClient(line));
			bp.id = id;
			return bp;
		});

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(MumpsDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const stk = this._runtime.stack(startFrame, endFrame);

		response.body = {
			stackFrames: stk.frames.map(f => new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line))),
			totalFrames: stk.count
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("Internal", this._variableHandles.create("internal"), false),
				new Scope("Local", this._variableHandles.create("local|0"), true)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {

		const variables: DebugProtocol.Variable[] = [];
		var insertVariable: DebugProtocol.Variable | undefined;
		console.log(args);
		//console.log(request);
		const varId = this._variableHandles.get(args.variablesReference);
		console.log(varId);
		if (varId == "internal") {
			var varObject = this._runtime.getVariables("internal");
			for (let varname in varObject) {
				variables.push({
					name: varname,
					type: 'string',
					value: varObject[varname],
					variablesReference: 0
				})
			}
		} else {
			const varparts: string[] = varId.split("|");
			const indexCount: number = parseInt(varparts.pop()!);
			const varBase = varparts.join("|");
			var varObject = this._runtime.getVariables("local");
			var lastVar: varData;
			var firstTime: boolean = true;
			var lastRef: string = "";
			for (let varname in varObject) {
				var actualVar = this.varAnalyze(varname, varObject[varname]);
				if (firstTime) { //First Variable not processed
					lastVar = actualVar;
					firstTime = false;
					continue;
				}
				if (insertVariable = this.checkVars(lastVar!, actualVar, indexCount, varBase, lastRef)) {
					if (insertVariable.variablesReference != 0) lastRef = lastVar!.bases[indexCount];
					variables.push(insertVariable);
				}
				lastVar = actualVar;
			}
			if (!firstTime) { // process Last Variable if there was minimum one
				var dummyVar: varData = { name: "", "indexCount": 0, "bases": [], "content": "" }
				if (insertVariable = this.checkVars(lastVar!, dummyVar, indexCount, varBase,lastRef)) {
					variables.push(insertVariable);
				}
			}
		}
		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}
	//checkVars checks if Variable has to be inserted in Var-Display and if it has descendants
	private checkVars(lastVar: varData, actualVar: varData, indexCount: number, varBase: string, lastRef: string): DebugProtocol.Variable | undefined {
		var returnVar: DebugProtocol.Variable | undefined = undefined;
		var actualReference: number = 0;
		if (indexCount==0 || (lastVar.bases[indexCount-1] == varBase && lastVar.indexCount > indexCount)) {
			if (lastVar.indexCount > indexCount + 1) {
				if (lastRef !== lastVar.bases[indexCount]) {
					var name = actualVar.bases[indexCount];
					if (indexCount > 0) name += ")";
					returnVar = {
						name,
						type: 'string',
						value: 'undefined',
						variablesReference: this._variableHandles.create(actualVar.bases[indexCount] + "|" + (indexCount + 1))
					};
				}
			} else { //lastVar.indexCount==indexCount+1
				if (lastVar.bases[indexCount] == actualVar.bases[indexCount]) actualReference = this._variableHandles.create(lastVar.bases[indexCount] + "|" + (indexCount + 1));
				returnVar = {
					name: lastVar.name,
					type: 'string',
					value: lastVar.content,
					variablesReference: actualReference
				};
			}
		}
		return returnVar
	}
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._runtime.step("OVER");
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void {
		this._runtime.step("INTO");
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void {
		this._runtime.step("OUTOF");
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		let reply: string = "";
		/*
		if (args.context === 'repl') {
			// 'evaluate' supports to create and delete breakpoints from the 'repl':
			const matches = /new +([0-9]+)/.exec(args.expression);
			if (matches && matches.length === 2) {
				const mbp = this._runtime.setBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
				const bp = <DebugProtocol.Breakpoint>new Breakpoint(mbp.verified, this.convertDebuggerLineToClient(mbp.line), undefined, this.createSource(this._runtime.sourceFile));
				bp.id = mbp.id;
				this.sendEvent(new BreakpointEvent('new', bp));
				reply = `breakpoint created`;
			} else {
				const matches = /del +([0-9]+)/.exec(args.expression);
				if (matches && matches.length === 2) {
					const mbp = this._runtime.clearBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
					if (mbp) {
						const bp = <DebugProtocol.Breakpoint>new Breakpoint(false);
						bp.id = mbp.id;
						this.sendEvent(new BreakpointEvent('removed', bp));
						reply = `breakpoint deleted`;
					}
				}
			}
		}*/
		if (args.context == "hover") {
			reply = args.expression + ":= " + this._runtime.getSingleVar(args.expression);
		}
		response.body = {
			result: reply,
			variablesReference: 0
		};
		this.sendResponse(response);
	}
	protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void {
		console.log(args);
	};
	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		console.log(args);
		this._runtime.disconnect();
		this.sendResponse(response);
	};
	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}

	private varAnalyze(varname: string, content: string): varData {
		var indexcount = 1;
		var bases: string[] = [];
		var length = varname.length;
		var klammerpos = varname.indexOf("(");
		var countKomma = true;
		//var lastKommaPos = varname.length;
		if (klammerpos > 0) {
			bases.push(varname.substring(0, klammerpos));
			indexcount++;
			//lastKommaPos = klammerpos;
			for (var i = klammerpos; i < length; i++) {
				if (varname.substring(i, i + 1) == "," && countKomma) {
					bases.push(varname.substring(0, i));
					indexcount++;
					//lastKommaPos = i;
				}
				if (varname.substring(i, i + 1) == '"') countKomma = !countKomma;
			}
			bases.push(varname.substring(0, varname.length - 1));
		} else {
			bases.push(varname);
		}
		return { "name": varname, "indexCount": indexcount, "bases": bases, content };
	}
}