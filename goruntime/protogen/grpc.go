package protogen

import "fmt"

func genServices(f *protoFile) (string, error) {
	g := newGen(f)
	ctxPkg := g.use("context", "context")
	grpcPkg := g.use("google.golang.org/grpc", "grpc")
	codesPkg := g.use("google.golang.org/grpc/codes", "codes")
	statusPkg := g.use("google.golang.org/grpc/status", "status")
	for _, s := range f.services {
		sv := GoCamelCase(s.name)
		full := s.name
		if f.pkg != "" {
			full = f.pkg + "." + s.name
		}
		lower := lowerFirst(sv)

		g.p("const (")
		for _, m := range s.methods {
			g.p("\t%s_%s_FullMethodName = %q", sv, GoCamelCase(m.name), "/"+full+"/"+m.name)
		}
		g.p(")")
		g.p("")

		// ---- client ----
		g.p("// %sClient is the client API for %s service.", sv, sv)
		g.p("type %sClient interface {", sv)
		for _, m := range s.methods {
			g.p("\t%s", g.clientSignature(sv, m))
		}
		g.p("}")
		g.p("")
		g.p("type %sClient struct {", lower)
		g.p("\tcc %s.ClientConnInterface", grpcPkg)
		g.p("}")
		g.p("")
		g.p("func New%sClient(cc %s.ClientConnInterface) %sClient {", sv, grpcPkg, sv)
		g.p("\treturn &%sClient{cc}", lower)
		g.p("}")
		g.p("")
		streamIndex := 0
		for _, m := range s.methods {
			mn := GoCamelCase(m.name)
			in, out := g.msgType(m.in), g.msgType(m.out)
			g.p("func (c *%sClient) %s {", lower, g.clientSignature(sv, m))
			if !m.clientStreams && !m.serverStreams {
				g.p("\tout := new(%s)", out)
				g.p("\terr := c.cc.Invoke(ctx, %s_%s_FullMethodName, in, out, opts...)", sv, mn)
				g.p("\tif err != nil {")
				g.p("\t\treturn nil, err")
				g.p("\t}")
				g.p("\treturn out, nil")
				g.p("}")
				g.p("")
				continue
			}
			impl := fmt.Sprintf("%s%sClient", lower, mn)
			g.p("\tstream, err := c.cc.NewStream(ctx, &%s_ServiceDesc.Streams[%d], %s_%s_FullMethodName, opts...)", sv, streamIndex, sv, mn)
			streamIndex++
			g.p("\tif err != nil {")
			g.p("\t\treturn nil, err")
			g.p("\t}")
			g.p("\tx := &%s{stream}", impl)
			if !m.clientStreams {
				g.p("\tif err := x.ClientStream.SendMsg(in); err != nil {")
				g.p("\t\treturn nil, err")
				g.p("\t}")
				g.p("\tif err := x.ClientStream.CloseSend(); err != nil {")
				g.p("\t\treturn nil, err")
				g.p("\t}")
			}
			g.p("\treturn x, nil")
			g.p("}")
			g.p("")
			iface := fmt.Sprintf("%s_%sClient", sv, mn)
			g.p("type %s interface {", iface)
			if m.clientStreams {
				g.p("\tSend(*%s) error", in)
			}
			switch {
			case m.serverStreams:
				g.p("\tRecv() (*%s, error)", out)
			default:
				g.p("\tCloseAndRecv() (*%s, error)", out)
			}
			g.p("\t%s.ClientStream", grpcPkg)
			g.p("}")
			g.p("")
			g.p("type %s struct {", impl)
			g.p("\t%s.ClientStream", grpcPkg)
			g.p("}")
			g.p("")
			if m.clientStreams {
				g.p("func (x *%s) Send(m *%s) error {", impl, in)
				g.p("\treturn x.ClientStream.SendMsg(m)")
				g.p("}")
				g.p("")
			}
			if m.serverStreams {
				g.p("func (x *%s) Recv() (*%s, error) {", impl, out)
			} else {
				g.p("func (x *%s) CloseAndRecv() (*%s, error) {", impl, out)
				g.p("\tif err := x.ClientStream.CloseSend(); err != nil {")
				g.p("\t\treturn nil, err")
				g.p("\t}")
			}
			g.p("\tm := new(%s)", out)
			g.p("\tif err := x.ClientStream.RecvMsg(m); err != nil {")
			g.p("\t\treturn nil, err")
			g.p("\t}")
			g.p("\treturn m, nil")
			g.p("}")
			g.p("")
		}

		// ---- server ----
		g.p("// %sServer is the server API for %s service. Implementations must embed", sv, sv)
		g.p("// Unimplemented%sServer for forward compatibility.", sv)
		g.p("type %sServer interface {", sv)
		for _, m := range s.methods {
			g.p("\t%s", g.serverSignature(sv, m))
		}
		g.p("\tmustEmbedUnimplemented%sServer()", sv)
		g.p("}")
		g.p("")
		g.p("// Unimplemented%sServer must be embedded to have forward compatible implementations.", sv)
		g.p("type Unimplemented%sServer struct{}", sv)
		g.p("")
		for _, m := range s.methods {
			mn := GoCamelCase(m.name)
			g.p("func (Unimplemented%sServer) %s {", sv, g.serverSignature(sv, m))
			if !m.clientStreams && !m.serverStreams {
				g.p("\treturn nil, %s.Errorf(%s.Unimplemented, \"method %s not implemented\")", statusPkg, codesPkg, mn)
			} else {
				g.p("\treturn %s.Errorf(%s.Unimplemented, \"method %s not implemented\")", statusPkg, codesPkg, mn)
			}
			g.p("}")
		}
		g.p("func (Unimplemented%sServer) mustEmbedUnimplemented%sServer() {}", sv, sv)
		g.p("")
		g.p("// Unsafe%sServer may be embedded to opt out of forward compatibility for this service.", sv)
		g.p("type Unsafe%sServer interface {", sv)
		g.p("\tmustEmbedUnimplemented%sServer()", sv)
		g.p("}")
		g.p("")
		g.p("func Register%sServer(s %s.ServiceRegistrar, srv %sServer) {", sv, grpcPkg, sv)
		g.p("\ts.RegisterService(_%s_bind(srv), srv)", sv)
		g.p("}")
		g.p("")
		// The bound copy of the service description.
		g.p("// _%s_bind is %s_ServiceDesc with its handlers bound to srv: native code cannot call the", sv, sv)
		g.p("// methods of an interpreted value it was handed, so the handlers close over srv instead.")
		g.p("func _%s_bind(srv %sServer) *%s.ServiceDesc {", sv, sv, grpcPkg)
		g.p("\treturn &%s.ServiceDesc{", grpcPkg)
		g.p("\t\tServiceName: %q,", full)
		g.p("\t\tHandlerType: (*%sServer)(nil),", sv)
		g.p("\t\tMethods: []%s.MethodDesc{", grpcPkg)
		for _, m := range s.methods {
			if m.clientStreams || m.serverStreams {
				continue
			}
			mn := GoCamelCase(m.name)
			g.p("\t\t\t{")
			g.p("\t\t\t\tMethodName: %q,", m.name)
			g.p("\t\t\t\tHandler: func(_ interface{}, ctx %s.Context, dec func(interface{}) error, interceptor %s.UnaryServerInterceptor) (interface{}, error) {", ctxPkg, grpcPkg)
			g.p("\t\t\t\t\treturn _%s_%s_Serve(srv, ctx, dec, interceptor)", sv, mn)
			g.p("\t\t\t\t},")
			g.p("\t\t\t},")
		}
		g.p("\t\t},")
		g.p("\t\tStreams: []%s.StreamDesc{", grpcPkg)
		for _, m := range s.methods {
			if !m.clientStreams && !m.serverStreams {
				continue
			}
			mn := GoCamelCase(m.name)
			g.p("\t\t\t{")
			g.p("\t\t\t\tStreamName: %q,", m.name)
			g.p("\t\t\t\tHandler: func(_ interface{}, stream %s.ServerStream) error {", grpcPkg)
			g.p("\t\t\t\t\treturn _%s_%s_Serve(srv, stream)", sv, mn)
			g.p("\t\t\t\t},")
			g.p("\t\t\t\tServerStreams: %v,", m.serverStreams)
			g.p("\t\t\t\tClientStreams: %v,", m.clientStreams)
			g.p("\t\t\t},")
		}
		g.p("\t\t},")
		g.p("\t\tMetadata: %q,", f.name)
		g.p("\t}")
		g.p("}")
		g.p("")
		for _, m := range s.methods {
			mn := GoCamelCase(m.name)
			in, out := g.msgType(m.in), g.msgType(m.out)
			if !m.clientStreams && !m.serverStreams {
				g.p("func _%s_%s_Handler(srv interface{}, ctx %s.Context, dec func(interface{}) error, interceptor %s.UnaryServerInterceptor) (interface{}, error) {", sv, mn, ctxPkg, grpcPkg)
				g.p("\treturn _%s_%s_Serve(srv.(%sServer), ctx, dec, interceptor)", sv, mn, sv)
				g.p("}")
				g.p("")
				g.p("func _%s_%s_Serve(srv %sServer, ctx %s.Context, dec func(interface{}) error, interceptor %s.UnaryServerInterceptor) (interface{}, error) {", sv, mn, sv, ctxPkg, grpcPkg)
				g.p("\tin := new(%s)", in)
				g.p("\tif err := dec(in); err != nil {")
				g.p("\t\treturn nil, err")
				g.p("\t}")
				g.p("\tif interceptor == nil {")
				g.p("\t\treturn srv.%s(ctx, in)", mn)
				g.p("\t}")
				g.p("\tinfo := &%s.UnaryServerInfo{", grpcPkg)
				g.p("\t\tServer:     srv,")
				g.p("\t\tFullMethod: %s_%s_FullMethodName,", sv, mn)
				g.p("\t}")
				g.p("\thandler := func(ctx %s.Context, req interface{}) (interface{}, error) {", ctxPkg)
				g.p("\t\treturn srv.%s(ctx, req.(*%s))", mn, in)
				g.p("\t}")
				g.p("\treturn interceptor(ctx, in, info, handler)")
				g.p("}")
				g.p("")
				continue
			}
			impl := fmt.Sprintf("%s%sServer", lower, mn)
			g.p("func _%s_%s_Handler(srv interface{}, stream %s.ServerStream) error {", sv, mn, grpcPkg)
			g.p("\treturn _%s_%s_Serve(srv.(%sServer), stream)", sv, mn, sv)
			g.p("}")
			g.p("")
			g.p("func _%s_%s_Serve(srv %sServer, stream %s.ServerStream) error {", sv, mn, sv, grpcPkg)
			if !m.clientStreams {
				g.p("\tm := new(%s)", in)
				g.p("\tif err := stream.RecvMsg(m); err != nil {")
				g.p("\t\treturn err")
				g.p("\t}")
				g.p("\treturn srv.%s(m, &%s{stream})", mn, impl)
			} else {
				g.p("\treturn srv.%s(&%s{stream})", mn, impl)
			}
			g.p("}")
			g.p("")
			iface := fmt.Sprintf("%s_%sServer", sv, mn)
			g.p("type %s interface {", iface)
			if m.serverStreams {
				g.p("\tSend(*%s) error", out)
			} else {
				g.p("\tSendAndClose(*%s) error", out)
			}
			if m.clientStreams {
				g.p("\tRecv() (*%s, error)", in)
			}
			g.p("\t%s.ServerStream", grpcPkg)
			g.p("}")
			g.p("")
			g.p("type %s struct {", impl)
			g.p("\t%s.ServerStream", grpcPkg)
			g.p("}")
			g.p("")
			if m.serverStreams {
				g.p("func (x *%s) Send(m *%s) error {", impl, out)
			} else {
				g.p("func (x *%s) SendAndClose(m *%s) error {", impl, out)
			}
			g.p("\treturn x.ServerStream.SendMsg(m)")
			g.p("}")
			g.p("")
			if m.clientStreams {
				g.p("func (x *%s) Recv() (*%s, error) {", impl, in)
				g.p("\tm := new(%s)", in)
				g.p("\tif err := x.ServerStream.RecvMsg(m); err != nil {")
				g.p("\t\treturn nil, err")
				g.p("\t}")
				g.p("\treturn m, nil")
				g.p("}")
				g.p("")
			}
		}
		// The static description, as protoc-gen-go-grpc writes it.
		g.p("// %s_ServiceDesc is the grpc.ServiceDesc for %s service.", sv, sv)
		g.p("var %s_ServiceDesc = %s.ServiceDesc{", sv, grpcPkg)
		g.p("\tServiceName: %q,", full)
		g.p("\tHandlerType: (*%sServer)(nil),", sv)
		g.p("\tMethods: []%s.MethodDesc{", grpcPkg)
		for _, m := range s.methods {
			if !m.clientStreams && !m.serverStreams {
				g.p("\t\t{MethodName: %q, Handler: _%s_%s_Handler},", m.name, sv, GoCamelCase(m.name))
			}
		}
		g.p("\t},")
		g.p("\tStreams: []%s.StreamDesc{", grpcPkg)
		for _, m := range s.methods {
			if m.clientStreams || m.serverStreams {
				g.p("\t\t{StreamName: %q, Handler: _%s_%s_Handler, ServerStreams: %v, ClientStreams: %v},", m.name, sv, GoCamelCase(m.name), m.serverStreams, m.clientStreams)
			}
		}
		g.p("\t},")
		g.p("\tMetadata: %q,", f.name)
		g.p("}")
		g.p("")
	}
	return g.finish(header(f))
}

func (g *gen) clientSignature(sv string, m *method) string {
	mn := GoCamelCase(m.name)
	ctx := "ctx context.Context"
	opts := "opts ...grpc.CallOption"
	switch {
	case !m.clientStreams && !m.serverStreams:
		return fmt.Sprintf("%s(%s, in *%s, %s) (*%s, error)", mn, ctx, g.msgType(m.in), opts, g.msgType(m.out))
	case !m.clientStreams:
		return fmt.Sprintf("%s(%s, in *%s, %s) (%s_%sClient, error)", mn, ctx, g.msgType(m.in), opts, sv, mn)
	}
	return fmt.Sprintf("%s(%s, %s) (%s_%sClient, error)", mn, ctx, opts, sv, mn)
}

func (g *gen) serverSignature(sv string, m *method) string {
	mn := GoCamelCase(m.name)
	switch {
	case !m.clientStreams && !m.serverStreams:
		return fmt.Sprintf("%s(context.Context, *%s) (*%s, error)", mn, g.msgType(m.in), g.msgType(m.out))
	case !m.clientStreams:
		return fmt.Sprintf("%s(*%s, %s_%sServer) error", mn, g.msgType(m.in), sv, mn)
	}
	return fmt.Sprintf("%s(%s_%sServer) error", mn, sv, mn)
}
