import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/patch-box3d-glue.mjs <box3d.mjs>");

let source = readFileSync(file, "utf8");

const replacements = [
  {
    pattern: /function createJsInvoker\(argTypes,isClassMethodFunc,returns,isAsync\)\{.*?\}function craftInvokerFunction/s,
    value: `function createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync){var needsDestructorStack=usesDestructorStack(argTypes);var argCount=argTypes.length-2;return function(humanName,throwBindingError,invoker,fn,runDestructors,fromRetWire,toClassParamWire,...converters){var toArgWire=converters.slice(0,argCount);return function(...args){var destructors=needsDestructorStack?[]:null;var wired=[];if(isClassMethodFunc){wired.push(toClassParamWire(destructors,this))}for(var i=0;i<argCount;++i){wired.push(toArgWire[i](destructors,args[i]))}var rv=invoker(fn,...wired);if(needsDestructorStack){runDestructors(destructors)}else{var typeIndex=isClassMethodFunc?1:2;for(var wiredIndex=0;typeIndex<argTypes.length;++typeIndex,++wiredIndex){var destructor=argTypes[typeIndex].destructorFunction;if(destructor!==null){destructor(wired[wiredIndex])}}}if(returns){return fromRetWire(rv)}}}}function craftInvokerFunction`,
  },
  {
    pattern: /var __emval_create_invoker=.*?;var __emval_get_global=/s,
    value: `var __emval_create_invoker=(argCount,argTypesPtr,kind)=>{var GenericWireTypeSize=8;var[retType,...argTypes]=emval_lookupTypes(argCount,argTypesPtr);var toReturnWire=retType.toWireType.bind(retType);var argFromPtr=argTypes.map(type=>type.readValueFromPointer.bind(type));argCount--;var invokerFunction=function(handle,methodName,destructorsRef,args){var converted=argFromPtr.map((read,index)=>read(args+index*GenericWireTypeSize));var value=Emval.toValue(handle);var result;switch(kind){case 0:result=value(...converted);break;case 1:result=value[getStringOrSymbol(methodName)](...converted);break;case 2:result=Reflect.construct(value,converted);break;case 3:result=converted.length===0?undefined:converted[converted.length-1];break}if(!retType.isVoid){return emval_returnValue(toReturnWire,destructorsRef,result)}};var functionName=\`methodCaller<(\${argTypes.map(t=>t.name)}) => \${retType.name}>\`;return emval_addMethodCaller(createNamedFunction(functionName,invokerFunction))};var __emval_get_global=`,
  },
  {
    pattern: /const makeOutParamReader=.*?;for\(const entry of/s,
    value: `const makeOutParamReader=(rawInto,sizes,trailing)=>{let byteOff=0;const slotPtrs=sizes.map(size=>{const pointer=SCRATCH+byteOff;byteOff+=size*4;return pointer});return function(...args){const outs=args.slice(0,sizes.length);const trailingArgs=args.slice(sizes.length);rawInto(...slotPtrs,...trailingArgs);const heap=getF32();let elementOffset=0;for(let outputIndex=0;outputIndex<sizes.length;outputIndex++){const size=sizes[outputIndex];const base=SCRATCH_F32+elementOffset;for(let valueIndex=0;valueIndex<size;valueIndex++){outs[outputIndex][valueIndex]=heap[base+valueIndex]}elementOffset+=size}return outs.length===1?outs[0]:outs}};for(const entry of`,
  },
];

for (const replacement of replacements) {
  if (!replacement.pattern.test(source)) throw new Error(`Box3D glue pattern not found: ${replacement.pattern}`);
  source = source.replace(replacement.pattern, replacement.value);
}

if (source.includes("new Function")) throw new Error("Box3D glue still contains dynamic code generation");
writeFileSync(file, source);
