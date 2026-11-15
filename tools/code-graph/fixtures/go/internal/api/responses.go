package api

func ok(body string) Response {
	return Response{Status: 200, Body: body}
}

func notFound(what string) Response {
	return Response{Status: 404, Body: what}
}
